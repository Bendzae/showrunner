//! Running CLI commands on another machine.
//!
//! Two kinds of host exist, both addressed by prefixing project or session
//! refs with `<name>:` (e.g. `ec2:myapp/fix-auth/2`). Any command carrying such
//! an arg is run as a whole on that host, prefixes stripped, by the
//! `showrunner` binary there:
//!
//! - the configured `[remote]`, reached over ssh (connection sharing keeps an
//!   `ask` polling loop at one handshake per ~10 minutes);
//! - the *peer*: the machine that linked to us. A [`Link`] holds an ssh
//!   connection to the remote with a reverse forward from the remote's
//!   loopback port (allocated by sshd) to a loopback listener here that
//!   executes allowed subcommands, and writes `peer.json` on the remote so its
//!   `showrunner` can find the way back. This is how sessions on a box behind
//!   a VPN talk to sessions on the laptop without the laptop being reachable.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::config::{self, Config, Project, Remote, Task};
use crate::tmux::{SessionStatus, TmuxSession};

/// Subcommands the peer may run here through the link.
const LINK_ALLOWED: &[&str] = &["list", "ask", "send", "output", "task", "session"];

/// The machine that linked to this one, as recorded in `peer.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Peer {
    pub name: String,
    pub port: u16,
}

fn peer_path() -> std::path::PathBuf {
    config::base_dir().join("peer.json")
}

/// A machine whose `showrunner` can run commands for us.
#[derive(Debug, Clone)]
pub enum Host {
    Ssh(Remote),
    Peer(Peer),
}

impl Host {
    pub fn name(&self) -> &str {
        match self {
            Host::Ssh(r) => &r.name,
            Host::Peer(p) => &p.name,
        }
    }

    /// Where the host is reached, for humans.
    pub fn location(&self) -> String {
        match self {
            Host::Ssh(r) => r.ssh.clone(),
            Host::Peer(p) => format!("linked, 127.0.0.1:{}", p.port),
        }
    }

    /// Run `showrunner <args>` on the host with output streamed to our stdio.
    pub fn run(&self, args: &[String]) -> Result<ExitStatus> {
        match self {
            Host::Ssh(remote) => ssh_command(remote, args)
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .status()
                .with_context(|| format!("failed to run ssh to remote '{}'", remote.name)),
            Host::Peer(peer) => {
                let mut stdout = std::io::stdout();
                let mut stderr = std::io::stderr();
                link_call(peer, args, &mut stdout, &mut stderr)
            }
        }
    }

    /// Run `showrunner <args>` on the host and return its stdout. A failing
    /// exit (or an unreachable host) is an error carrying the command's stderr.
    pub fn output(&self, args: &[String]) -> Result<String> {
        let (status, out, err) = match self {
            Host::Ssh(remote) => {
                let out = ssh_command(remote, args)
                    .stdin(Stdio::null())
                    .output()
                    .with_context(|| format!("failed to run ssh to remote '{}'", remote.name))?;
                (out.status, out.stdout, out.stderr)
            }
            Host::Peer(peer) => {
                let (mut out, mut err) = (Vec::new(), Vec::new());
                let status = link_call(peer, args, &mut out, &mut err)?;
                (status, out, err)
            }
        };
        if !status.success() {
            bail!("'{}' failed: {}", self.name(), failure_text(&err, status));
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
}

/// Where a command runs: here, or on one of the hosts.
#[derive(Debug, Clone)]
pub enum Target {
    Local,
    Host(Host),
}

impl Target {
    pub fn name(&self) -> &str {
        match self {
            Target::Local => "local",
            Target::Host(h) => h.name(),
        }
    }

    /// `local`, or the name of a known host.
    pub fn by_name(cfg: &Config, name: &str) -> Result<Target> {
        if name == "local" {
            return Ok(Target::Local);
        }
        hosts(cfg)
            .into_iter()
            .find(|h| h.name() == name)
            .map(Target::Host)
            .ok_or_else(|| {
                anyhow::anyhow!("unknown host '{name}' (expected `local` or a host from `list`)")
            })
    }

    /// Split a possibly host-prefixed ref into its target and bare ref.
    pub fn split_ref(cfg: &Config, reference: &str) -> (Target, String) {
        hosts(cfg)
            .into_iter()
            .find_map(|h| {
                let bare = reference.strip_prefix(&format!("{}:", h.name()))?;
                Some((Target::Host(h), bare.to_string()))
            })
            .unwrap_or_else(|| (Target::Local, reference.to_string()))
    }

    /// Run `showrunner <args>` there and return its stdout.
    pub fn output(&self, args: &[String]) -> Result<String> {
        match self {
            Target::Host(host) => host.output(args),
            Target::Local => {
                let out = Command::new(std::env::current_exe()?)
                    .args(args)
                    .stdin(Stdio::null())
                    .output()?;
                if !out.status.success() {
                    bail!("{}", failure_text(&out.stderr, out.status));
                }
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            }
        }
    }
}

/// The last stderr line of a failed command, or its exit status when silent.
fn failure_text(stderr: &[u8], status: ExitStatus) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().trim_start_matches("Error: ").to_string())
        .unwrap_or_else(|| format!("exit status {}", status.code().unwrap_or(1)))
}

/// Every host commands can be proxied to: the configured remote, plus the peer
/// that linked to us, if any.
pub fn hosts(cfg: &Config) -> Vec<Host> {
    let mut hosts: Vec<Host> = cfg.remote.clone().map(Host::Ssh).into_iter().collect();
    if let Some(peer) = std::fs::read_to_string(peer_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Peer>(&s).ok())
    {
        hosts.push(Host::Peer(peer));
    }
    hosts
}

/// Strip `<name>:` from every arg that carries it. Returns `None` when no arg
/// is addressed to that host. A bare `<name>:` (as in `list ec2:`) is dropped
/// rather than passed on as an empty positional.
pub fn strip_prefixes(name: &str, args: &[String]) -> Option<Vec<String>> {
    let prefix = format!("{name}:");
    if !args.iter().any(|a| a.starts_with(&prefix)) {
        return None;
    }
    Some(
        args.iter()
            .filter_map(|a| match a.strip_prefix(&prefix) {
                Some("") => None,
                Some(rest) => Some(rest.to_string()),
                None => Some(a.clone()),
            })
            .collect(),
    )
}

fn ssh_base(remote: &Remote) -> Command {
    let control_path = config::base_dir().join(format!("ssh-{}.ctl", remote.name));
    let mut cmd = Command::new("ssh");
    cmd.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "ControlMaster=auto",
        "-o",
        "ControlPersist=10m",
        "-o",
        &format!("ControlPath={}", control_path.display()),
    ]);
    cmd
}

fn ssh_command(remote: &Remote, args: &[String]) -> Command {
    let remote_cmd = std::iter::once(remote.bin.as_str())
        .chain(args.iter().map(String::as_str))
        .map(shell_escape)
        .collect::<Vec<_>>()
        .join(" ");
    let mut cmd = ssh_base(remote);
    cmd.args([&remote.ssh, &remote_cmd]);
    cmd
}

fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Attach to a tmux session on the remote, on this terminal.
pub fn attach(remote: &Remote, tmux_name: &str) -> Result<()> {
    let status = ssh_base(remote)
        .args([
            "-t",
            &remote.ssh,
            &format!("tmux attach-session -t {}", shell_escape(tmux_name)),
        ])
        .status()?;
    if !status.success() {
        bail!("ssh to '{}' exited with {}", remote.name, status);
    }
    Ok(())
}

/// Project paths on a host are stored as `<host>:<path>` so every list item
/// carrying a project path knows where it lives.
pub fn host_of_path(path: &str) -> Option<(&str, &str)> {
    if path.starts_with('/') || path.starts_with('~') {
        return None;
    }
    path.split_once(':')
}

/// What a host's `list --json` said, reshaped into the TUI's own types.
#[derive(Debug, Clone, Default)]
pub struct HostSnapshot {
    pub host: String,
    pub location: String,
    pub projects: Vec<Project>,
    pub sessions: Vec<TmuxSession>,
    /// Keyed by `TmuxSession::key()`.
    pub statuses: HashMap<String, SessionStatus>,
    pub agents: HashMap<String, String>,
    pub error: Option<String>,
}

pub fn fetch_snapshot(host: &Host) -> HostSnapshot {
    // A ref prefix stops the host from listing *its* hosts in turn (us).
    let args: Vec<String> = ["list", "--json", "--ref-prefix=-"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let parsed = host
        .output(&args)
        .and_then(|text| Ok(serde_json::from_str::<serde_json::Value>(text.trim())?));
    match parsed {
        Ok(listing) => snapshot_from_listing(host.name(), host.location(), &listing),
        Err(e) => HostSnapshot {
            host: host.name().to_string(),
            location: host.location(),
            error: Some(e.to_string()),
            ..Default::default()
        },
    }
}

fn snapshot_from_listing(
    host: &str,
    location: String,
    listing: &serde_json::Value,
) -> HostSnapshot {
    let mut snapshot = HostSnapshot {
        host: host.to_string(),
        location,
        ..Default::default()
    };

    let str_of = |v: &serde_json::Value, k: &str| v[k].as_str().unwrap_or_default().to_string();
    let add_session = |snapshot: &mut HostSnapshot, v: &serde_json::Value| {
        let Some(mut session) = TmuxSession::from_tmux_name(&str_of(v, "tmux_name")) else {
            return;
        };
        session.host = Some(snapshot.host.clone());
        let key = session.key();
        if let Some(status) = v["status"].as_str().and_then(SessionStatus::parse) {
            snapshot.statuses.insert(key.clone(), status);
        }
        if let Some(agent) = v["agent"].as_str() {
            snapshot.agents.insert(key, agent.to_string());
        }
        snapshot.sessions.push(session);
    };

    for p in listing["projects"].as_array().into_iter().flatten() {
        let tasks = p["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|t| Task {
                name: str_of(t, "name"),
                branch: str_of(t, "branch"),
                base_branch: t["base_branch"]
                    .as_str()
                    .filter(|b| *b != "main")
                    .map(str::to_string),
                archived: t["archived"].as_bool().unwrap_or(false),
                group: t["group"].as_str().map(str::to_string),
            })
            .collect();
        for t in p["tasks"].as_array().into_iter().flatten() {
            for v in t["sessions"].as_array().into_iter().flatten() {
                add_session(&mut snapshot, v);
            }
        }
        for v in p["adhoc_sessions"].as_array().into_iter().flatten() {
            add_session(&mut snapshot, v);
        }
        snapshot.projects.push(Project {
            name: str_of(p, "name"),
            path: format!("{}:{}", snapshot.host, str_of(p, "path")),
            tasks,
            copy_patterns: Vec::new(),
            setup_commands: Vec::new(),
            run_command: None,
        });
    }
    snapshot
}

/// Polls every host's listing in the background for the TUI.
pub struct HostPoller {
    pub latest: Arc<Mutex<Option<Vec<HostSnapshot>>>>,
}

impl HostPoller {
    pub fn spawn() -> Self {
        let latest: Arc<Mutex<Option<Vec<HostSnapshot>>>> = Arc::new(Mutex::new(None));
        let slot = latest.clone();
        thread::spawn(move || {
            // Hosts seen reachable on the previous round. A host that just
            // (re)appeared may have rebooted with its sessions gone from
            // tmux, and nobody opens a TUI there to bring them back: run its
            // `restore` once before listing it.
            let mut reachable: HashSet<String> = HashSet::new();
            loop {
                let hosts = Config::load().map(|cfg| hosts(&cfg)).unwrap_or_default();
                let snapshots: Vec<HostSnapshot> = hosts
                    .iter()
                    .map(|host| {
                        let mut snapshot = fetch_snapshot(host);
                        if snapshot.error.is_none() && !reachable.contains(host.name()) {
                            let restored = host
                                .output(&["restore".to_string()])
                                .is_ok_and(|out| out.contains("restored "));
                            if restored {
                                snapshot = fetch_snapshot(host);
                            }
                        }
                        match snapshot.error {
                            None => reachable.insert(host.name().to_string()),
                            Some(_) => reachable.remove(host.name()),
                        };
                        snapshot
                    })
                    .collect();
                *slot.lock().unwrap() = Some(snapshots);
                thread::sleep(Duration::from_secs(3));
            }
        });
        HostPoller { latest }
    }
}

// ---- link wire format -------------------------------------------------------
//
// Client → server: one JSON line, the argv. Server → client: frames of a tag
// byte (1 stdout, 2 stderr, 3 exit status), a big-endian u32 length, payload.

const TAG_STDOUT: u8 = 1;
const TAG_STDERR: u8 = 2;
const TAG_EXIT: u8 = 3;

fn write_frame(w: &mut impl Write, tag: u8, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&[tag])?;
    w.write_all(&(payload.len() as u32).to_be_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

/// Run `showrunner <args>` on the peer through the link, copying its stdout and
/// stderr into the given writers.
fn link_call(
    peer: &Peer,
    args: &[String],
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> Result<ExitStatus> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, peer.port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .with_context(|| format!("peer '{}' is not linked right now", peer.name))?;
    stream.write_all(serde_json::to_string(args)?.as_bytes())?;
    stream.write_all(b"\n")?;

    loop {
        let mut header = [0u8; 5];
        stream
            .read_exact(&mut header)
            .with_context(|| format!("link to '{}' closed early", peer.name))?;
        let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        let mut payload = vec![0u8; len];
        stream.read_exact(&mut payload)?;
        match header[0] {
            TAG_STDOUT => stdout.write_all(&payload)?,
            TAG_STDERR => stderr.write_all(&payload)?,
            TAG_EXIT => {
                let code = i32::from_be_bytes(payload[..4].try_into()?);
                return Ok(exit_status(code));
            }
            other => bail!("bad frame tag {other} from peer '{}'", peer.name),
        }
    }
}

#[cfg(unix)]
fn exit_status(code: i32) -> ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    ExitStatus::from_raw(code << 8)
}

/// Serve one link connection: run the requested subcommand here and stream
/// its output back.
fn serve_link_connection(stream: TcpStream) -> Result<()> {
    let mut line = String::new();
    BufReader::new(stream.try_clone()?).read_line(&mut line)?;
    let args: Vec<String> = serde_json::from_str(line.trim())?;
    let writer = Arc::new(Mutex::new(stream));

    let allowed = args
        .first()
        .is_some_and(|cmd| LINK_ALLOWED.contains(&cmd.as_str()));
    if !allowed {
        let msg = format!("'{}' cannot be run through the link\n", args.join(" "));
        let mut w = writer.lock().unwrap();
        write_frame(&mut *w, TAG_STDERR, msg.as_bytes())?;
        write_frame(&mut *w, TAG_EXIT, &2i32.to_be_bytes())?;
        return Ok(());
    }

    let mut child = Command::new(std::env::current_exe()?)
        .args(&args)
        // The peer's command is not "inside" whatever tmux session hosts us.
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let pump = |mut reader: Box<dyn Read + Send>, tag: u8, writer: Arc<Mutex<TcpStream>>| {
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut w = writer.lock().unwrap();
                if write_frame(&mut *w, tag, &buf[..n]).is_err() {
                    break;
                }
            }
        })
    };
    let out = pump(
        Box::new(child.stdout.take().unwrap()),
        TAG_STDOUT,
        writer.clone(),
    );
    let err = pump(
        Box::new(child.stderr.take().unwrap()),
        TAG_STDERR,
        writer.clone(),
    );
    let status = child.wait()?;
    let _ = out.join();
    let _ = err.join();
    let mut w = writer.lock().unwrap();
    write_frame(&mut *w, TAG_EXIT, &status.code().unwrap_or(1).to_be_bytes())?;
    Ok(())
}

/// The laptop side of a link: a loopback listener executing the peer's
/// commands, and an ssh connection to the remote that reverse-forwards a
/// port there to it. Reconnects with backoff while the remote is
/// unreachable (VPN down, box asleep). Dropping it closes the ssh connection.
pub struct Link {
    ssh: Arc<Mutex<Option<Child>>>,
    stopped: Arc<Mutex<bool>>,
    connected: Arc<AtomicBool>,
}

impl Link {
    /// Whether the reverse forward is currently up.
    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    pub fn start(remote: &Remote) -> Result<Link> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                thread::spawn(move || {
                    let _ = serve_link_connection(stream);
                });
            }
        });

        let link = Link {
            ssh: Arc::new(Mutex::new(None)),
            stopped: Arc::new(Mutex::new(false)),
            connected: Arc::new(AtomicBool::new(false)),
        };
        let ssh = link.ssh.clone();
        let stopped = link.stopped.clone();
        let connected = link.connected.clone();
        let remote = remote.clone();
        let peer_name = remote
            .local_name
            .clone()
            .unwrap_or_else(crate::app::detect_hostname);
        thread::spawn(move || {
            let mut backoff = Duration::from_secs(2);
            wake(&remote);
            while !*stopped.lock().unwrap() {
                let held = hold_forward(&remote, port, &peer_name, &ssh, &stopped, &connected);
                connected.store(false, Ordering::Relaxed);
                backoff = if held {
                    Duration::from_secs(2)
                } else {
                    (backoff * 2).min(Duration::from_secs(60))
                };
                thread::sleep(backoff);
            }
        });
        Ok(link)
    }

    pub fn stop(&self) {
        *self.stopped.lock().unwrap() = true;
        if let Some(mut child) = self.ssh.lock().unwrap().take() {
            // Killing only the shell watchdog would orphan ssh (and leave its
            // forward on the remote): signal the whole process group.
            let _ = Command::new("kill")
                .args(["-TERM", &format!("-{}", child.id())])
                .status();
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Run the configured `wake_command` once, before the first link attempt —
/// e.g. to start a stopped instance the link would otherwise wait for.
fn wake(remote: &Remote) {
    let Some(command) = &remote.wake_command else {
        return;
    };
    let _ = Command::new("sh")
        .args(["-c", command])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Tell the remote who we are and where its `<name>:` refs come back through.
fn register_peer(remote: &Remote, peer: &Peer) -> Result<()> {
    let json = serde_json::to_string(peer)?;
    let script = format!(
        "mkdir -p ~/.showrunner && printf '%s' {} > ~/.showrunner/peer.json",
        shell_escape(&json)
    );
    let status = ssh_base(remote)
        .args([&remote.ssh, &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !status.success() {
        bail!("could not write peer.json on '{}'", remote.name);
    }
    Ok(())
}

/// Hold a reverse forward open until the connection drops, telling the remote
/// where it landed. sshd allocates the port (`-R 0`): a forward whose client
/// vanished (VPN drop, laptop asleep) lingers on the remote until sshd notices
/// — by default never — so a fixed port would stay blocked for the reconnect.
/// Returns whether the forward was established at all (so the caller can tell
/// a flaky link from a dead one).
fn hold_forward(
    remote: &Remote,
    local_port: u16,
    peer_name: &str,
    slot: &Arc<Mutex<Option<Child>>>,
    stopped: &Arc<Mutex<bool>>,
    connected: &Arc<AtomicBool>,
) -> bool {
    let forward = format!("127.0.0.1:0:127.0.0.1:{local_port}");
    // Own connection, not a shared master: a forward requested through a
    // master outlives the requesting client. The shell watchdog kills ssh once
    // this process is gone (a signal skips `Drop`), for the same reason.
    let ssh = [
        "ssh",
        "-N",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        // The allocated port is reported at INFO level.
        "-o",
        "LogLevel=INFO",
        "-R",
        &forward,
        &remote.ssh,
    ]
    .iter()
    .map(|a| shell_escape(a))
    .collect::<Vec<_>>()
    .join(" ");
    let script = format!(
        "{ssh} & p=$!; while kill -0 $PPID 2>/dev/null && kill -0 $p 2>/dev/null; do sleep 2; done; kill $p 2>/dev/null; wait $p"
    );
    let mut command = Command::new("sh");
    command
        .args(["-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // Own process group, so `stop` can take down the watchdog *and* ssh.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let child = command.spawn();
    let Ok(mut child) = child else {
        return false;
    };
    let stderr = child.stderr.take();
    *slot.lock().unwrap() = Some(child);

    // Wait for "Allocated port N for remote forward to ..." on stderr, then
    // keep draining it so ssh never blocks on a full pipe.
    let (port_tx, port_rx) = std::sync::mpsc::channel::<u16>();
    if let Some(stderr) = stderr {
        thread::spawn(move || {
            let mut sent = false;
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !sent && let Some(port) = allocated_port(&line) {
                    let _ = port_tx.send(port);
                    sent = true;
                }
            }
        });
    }
    let started = std::time::Instant::now();
    let mut registered = false;
    loop {
        thread::sleep(Duration::from_millis(500));
        if !registered && let Ok(port) = port_rx.try_recv() {
            let peer = Peer {
                name: peer_name.to_string(),
                port,
            };
            registered = register_peer(remote, &peer).is_ok();
            connected.store(registered, Ordering::Relaxed);
        }
        let mut guard = slot.lock().unwrap();
        let Some(child) = guard.as_mut() else {
            return true;
        };
        match child.try_wait() {
            Ok(None) => {}
            _ => {
                *guard = None;
                // A connection that died within seconds never really came up.
                return started.elapsed() > Duration::from_secs(10) || *stopped.lock().unwrap();
            }
        }
    }
}

/// The port sshd chose, from ssh's "Allocated port 43210 for remote forward
/// to 127.0.0.1:50726" log line.
fn allocated_port(line: &str) -> Option<u16> {
    let rest = line.split("Allocated port ").nth(1)?;
    rest.split_whitespace().next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote() -> Remote {
        Remote {
            name: "ec2".into(),
            ssh: "ben@box".into(),
            bin: "showrunner".into(),
            local_name: None,
            wake_command: None,
        }
    }

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn strip_prefixes_ignores_unaddressed_commands() {
        assert_eq!(
            strip_prefixes("ec2", &args(&["ask", "app/task", "q"])),
            None
        );
        assert_eq!(strip_prefixes("ec2", &args(&["list"])), None);
    }

    #[test]
    fn strip_prefixes_rewrites_every_addressed_arg_and_drops_bare_prefix() {
        assert_eq!(
            strip_prefixes(
                "ec2",
                &args(&["ask", "ec2:app/task/2", "q?", "--timeout", "10"])
            ),
            Some(args(&["ask", "app/task/2", "q?", "--timeout", "10"]))
        );
        assert_eq!(
            strip_prefixes("ec2", &args(&["list", "ec2:", "--json"])),
            Some(args(&["list", "--json"]))
        );
    }

    #[test]
    fn ssh_command_escapes_args_for_the_remote_shell() {
        let cmd = ssh_command(&remote(), &args(&["ask", "app/task", "what's up?"]));
        let argv: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(argv[argv.len() - 2], "ben@box");
        assert_eq!(
            argv[argv.len() - 1],
            "'showrunner' 'ask' 'app/task' 'what'\\''s up?'"
        );
    }

    #[test]
    fn allocated_port_is_read_from_the_ssh_log_line() {
        assert_eq!(
            allocated_port("Allocated port 43210 for remote forward to 127.0.0.1:50726"),
            Some(43210)
        );
        assert_eq!(
            allocated_port("Warning: Permanently added 'box' to hosts"),
            None
        );
    }

    #[test]
    fn host_of_path_only_splits_prefixed_paths() {
        assert_eq!(
            host_of_path("ec2:/home/ben/app"),
            Some(("ec2", "/home/ben/app"))
        );
        assert_eq!(host_of_path("/Users/ben/app"), None);
        assert_eq!(host_of_path("~/app"), None);
    }

    #[test]
    fn snapshot_reshapes_a_host_listing_into_prefixed_projects_and_keyed_sessions() {
        let listing = serde_json::json!({
            "projects": [{
                "name": "App", "path": "/home/ben/app",
                "tasks": [{
                    "name": "Fix auth", "branch": "fix-auth", "base_branch": "main",
                    "archived": false, "group": "Auth",
                    "sessions": [{
                        "ref": "-App/Fix-auth/main", "tmux_name": "cm__App__Fix-auth__main",
                        "name": "main", "status": "waiting_input", "agent": "codex"
                    }]
                }],
                "adhoc_sessions": [{
                    "ref": "-App/adhoc/scratch", "tmux_name": "cm__App__adhoc__scratch",
                    "name": "scratch", "status": "running", "agent": "claude"
                }]
            }]
        });
        let snap = snapshot_from_listing("ec2", "ben@box".into(), &listing);
        assert_eq!(snap.projects.len(), 1);
        assert_eq!(snap.projects[0].path, "ec2:/home/ben/app");
        assert_eq!(snap.projects[0].tasks[0].base_branch, None);
        assert_eq!(snap.projects[0].tasks[0].group.as_deref(), Some("Auth"));
        assert_eq!(snap.sessions.len(), 2);
        assert_eq!(snap.sessions[0].host.as_deref(), Some("ec2"));
        assert_eq!(snap.sessions[0].key(), "ec2:cm__App__Fix-auth__main");
        assert_eq!(snap.sessions[0].reference(), "ec2:App/Fix-auth/main");
        assert_eq!(
            snap.statuses.get("ec2:cm__App__adhoc__scratch"),
            Some(&SessionStatus::Running)
        );
        assert_eq!(
            snap.agents
                .get("ec2:cm__App__Fix-auth__main")
                .map(String::as_str),
            Some("codex")
        );
        assert!(snap.error.is_none());
    }

    #[test]
    fn link_call_streams_frames_and_exit_status() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            assert_eq!(line.trim(), r#"["output","app/task"]"#);
            write_frame(&mut stream, TAG_STDOUT, b"hello ").unwrap();
            write_frame(&mut stream, TAG_STDERR, b"warn").unwrap();
            write_frame(&mut stream, TAG_STDOUT, b"world").unwrap();
            write_frame(&mut stream, TAG_EXIT, &3i32.to_be_bytes()).unwrap();
        });

        let peer = Peer {
            name: "mac".into(),
            port,
        };
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let status = link_call(&peer, &args(&["output", "app/task"]), &mut out, &mut err).unwrap();
        assert_eq!(out, b"hello world");
        assert_eq!(err, b"warn");
        assert_eq!(status.code(), Some(3));
    }

    #[test]
    fn link_server_refuses_commands_outside_the_allowlist() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            serve_link_connection(stream).unwrap();
        });

        let peer = Peer {
            name: "mac".into(),
            port,
        };
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let status = link_call(
            &peer,
            &args(&["serve", "--bind", "0.0.0.0:1"]),
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(status.code(), Some(2));
        assert!(String::from_utf8_lossy(&err).contains("cannot be run through the link"));
    }
}
