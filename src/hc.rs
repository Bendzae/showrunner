//! The one place showrunner talks to herdr-core (`hc`), the terminal runtime
//! sessions run in. Calls go through hc's JSON-RPC API (`hc connect`), whose
//! records carry labels and status that `hc ls` leaves out. hc is young and its
//! API a preview, so keep every call here.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Terminal {
    pub address: String,
    #[serde(default)]
    pub state: String,
    /// What it was started with; a recovered shell's after a kept terminal
    /// lost its program.
    #[serde(default)]
    pub argv: Vec<String>,
    #[serde(default)]
    pub labels: HashMap<String, String>,
    /// The program's own OSC 7501 report; `None` if it never sent one.
    #[serde(default)]
    pub status: Option<Status>,
    /// What runs in it right now; `None` once it has finished.
    #[serde(default)]
    pub foreground: Option<Foreground>,
    #[serde(default)]
    pub cols: u16,
    #[serde(default)]
    pub rows: u16,
}

impl Terminal {
    pub fn is_live(&self) -> bool {
        self.state == "live"
    }

    pub fn label(&self, key: &str) -> Option<&str> {
        self.labels.get(key).map(String::as_str)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Foreground {
    /// The process name as the OS has it (`node`, `zsh`).
    pub name: String,
    #[serde(default)]
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Status {
    /// idle, working, done, blocked or error.
    pub state: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SendResult {
    #[serde(default)]
    pub wait: Option<WaitResult>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct WaitResult {
    /// False when the wait timed out with the turn still running.
    pub ended: bool,
    /// `not_started` when the program never began working on the send.
    #[serde(default)]
    pub reason: String,
    /// The status word the turn ended on.
    #[serde(default)]
    pub status: Option<String>,
}

/// What a Claude Code session (or tmux) sets for its own processes. hc's first
/// call auto-starts the core, which hands its environment to every terminal,
/// so a core started from inside a Claude session would otherwise run all
/// agents as that session's children (with transcript saving, and so resume,
/// turned off).
const INHERITED_SESSION_VARS: &[&str] = &[
    "TMUX",
    "TMUX_PANE",
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "AI_AGENT",
    "HC_TERMINAL_ID",
];

fn hc() -> Command {
    let mut cmd = Command::new("hc");
    for var in INHERITED_SESSION_VARS {
        cmd.env_remove(var);
    }
    cmd
}

fn connect() -> Result<Child> {
    hc().arg("connect")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("could not run `hc` (is herdr-core installed?)")
}

fn result_of(reply: Value) -> Result<Value> {
    if let Some(error) = reply.get("error") {
        let message = error["message"].as_str().unwrap_or("hc call failed");
        bail!("{message}");
    }
    Ok(reply["result"].clone())
}

fn call(method: &str, params: Value) -> Result<Value> {
    let mut child = connect()?;
    let request = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{request}")?;
    drop(stdin);
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line)?;
    if line.trim().is_empty() {
        let mut stderr = String::new();
        let _ = child.stderr.take().unwrap().read_to_string(&mut stderr);
        let _ = child.wait();
        let reply: Value = serde_json::from_str(&stderr).unwrap_or_default();
        let message = reply["error"]["message"].as_str().unwrap_or(stderr.trim());
        bail!("hc {method} failed: {message}");
    }
    let _ = child.wait();
    result_of(serde_json::from_str(&line)?)
}

/// Live terminals carrying all of `labels`.
pub fn list(labels: &[(&str, &str)]) -> Result<Vec<Terminal>> {
    list_where(labels, false)
}

/// Like [`list`], finished terminals included.
pub fn list_all(labels: &[(&str, &str)]) -> Result<Vec<Terminal>> {
    list_where(labels, true)
}

fn list_where(labels: &[(&str, &str)], all: bool) -> Result<Vec<Terminal>> {
    let labels: HashMap<&str, &str> = labels.iter().copied().collect();
    let result = call("terminal.list", json!({"labels": labels, "all": all}))?;
    Ok(serde_json::from_value(result["terminals"].clone())?)
}

pub fn get(terminal: &str) -> Result<Terminal> {
    Ok(serde_json::from_value(call(
        "terminal.get",
        json!({"terminal": terminal}),
    )?)?)
}

/// Run the shell line `command` (none: the machine's own shell) in a new
/// terminal rooted at `cwd`; returns its address. Terminals are never children
/// of the caller: a session started from inside another one must outlive it.
pub fn run(cwd: &str, command: Option<&str>, labels: &[(&str, &str)]) -> Result<String> {
    let labels: HashMap<&str, &str> = labels.iter().copied().collect();
    let result = call(
        "terminal.run",
        json!({
            "line": command,
            "cwd": cwd,
            "labels": labels,
            "no_parent": true,
            "no_notify": true,
        }),
    )?;
    result["address"]
        .as_str()
        .map(str::to_string)
        .context("hc did not return the new terminal's address")
}

pub fn set_labels(terminal: &str, labels: &[(&str, &str)]) -> Result<()> {
    let labels: HashMap<&str, &str> = labels.iter().copied().collect();
    call(
        "terminal.label",
        json!({"terminal": terminal, "labels": labels}),
    )?;
    Ok(())
}

/// Paste `text` and press Enter. With `wait`, also wait (up to that many
/// seconds) for the turn it started; only agents reporting status have turns.
pub fn send(terminal: &str, text: &str, wait: Option<u64>) -> Result<SendResult> {
    let mut params = json!({"terminal": terminal, "text": text});
    if let Some(timeout) = wait {
        params["wait"] = json!(true);
        params["timeout"] = json!(timeout);
    }
    Ok(serde_json::from_value(call("terminal.send", params)?)?)
}

/// Press named keys (`enter`, `esc`, `up`, `ctrl+c`, `1`, …).
pub fn keys(terminal: &str, keys: &[&str]) -> Result<()> {
    call("terminal.keys", json!({"terminal": terminal, "keys": keys}))?;
    Ok(())
}

/// The screen plus `lines` lines of history, as plain text.
pub fn read(terminal: &str, lines: usize) -> Result<String> {
    let result = call(
        "terminal.read",
        json!({"terminal": terminal, "lines": lines}),
    )?;
    Ok(result["text"].as_str().unwrap_or_default().to_string())
}

/// End the terminal's program and remove the terminal.
pub fn kill(terminal: &str) {
    let _ = call("terminal.kill", json!({"terminal": terminal}));
    remove(terminal);
}

/// Remove a finished terminal.
pub fn remove(terminal: &str) {
    let _ = call("terminal.rm", json!({"terminal": terminal}));
}

/// Put this terminal on `terminal` until the person detaches (ctrl+\).
pub fn attach(terminal: &str) -> Result<()> {
    let status = hc().args(["attach", terminal]).status()?;
    if !status.success() {
        bail!("hc attach exited with {status}");
    }
    Ok(())
}

const FRAME_DATA: u8 = 0;
const FRAME_CLOSE: u8 = 2;

/// Paste `text` without submitting it. hc's `send` always presses Enter, so
/// this attaches as a viewer for a moment (at the terminal's own size, so
/// nothing resizes) and types a bracketed paste on the stream.
pub fn paste(terminal: &Terminal, text: &str) -> Result<()> {
    let mut child = connect()?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    writeln!(
        stdin,
        "{}",
        json!({"jsonrpc": "2.0", "id": 1, "method": "hello", "params": {"framed": true}})
    )?;
    let mut hello = String::new();
    stdout.read_line(&mut hello)?;
    result_of(serde_json::from_str(&hello)?)?;

    let attach = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "terminal.attach",
        "params": {"terminal": terminal.address, "cols": terminal.cols, "rows": terminal.rows},
    });
    write_frame(&mut stdin, 0, FRAME_DATA, attach.to_string().as_bytes())?;
    let channel = loop {
        let (channel, _, payload) = read_frame(&mut stdout)?;
        if channel == 0 {
            let reply = result_of(serde_json::from_slice(&payload)?)?;
            break reply["channel"]
                .as_u64()
                .context("hc attach returned no channel")? as u32;
        }
    };

    let pasted = format!("\x1b[200~{text}\x1b[201~");
    write_frame(&mut stdin, channel, FRAME_DATA, pasted.as_bytes())?;
    write_frame(&mut stdin, channel, FRAME_CLOSE, &[])?;
    // The core answers CLOSE once the stream is done, input delivered.
    loop {
        let (from, kind, _) = read_frame(&mut stdout)?;
        if from == channel && kind == FRAME_CLOSE {
            break;
        }
    }
    drop(stdin);
    let _ = child.wait();
    Ok(())
}

fn write_frame(out: &mut ChildStdin, channel: u32, kind: u8, payload: &[u8]) -> Result<()> {
    out.write_all(&channel.to_le_bytes())?;
    out.write_all(&[kind])?;
    out.write_all(&(payload.len() as u32).to_le_bytes())?;
    out.write_all(payload)?;
    out.flush()?;
    Ok(())
}

fn read_frame(input: &mut BufReader<ChildStdout>) -> Result<(u32, u8, Vec<u8>)> {
    let mut header = [0u8; 9];
    input.read_exact(&mut header)?;
    let channel = u32::from_le_bytes(header[0..4].try_into().unwrap());
    let len = u32::from_le_bytes(header[5..9].try_into().unwrap()) as usize;
    let mut payload = vec![0u8; len];
    input.read_exact(&mut payload)?;
    Ok((channel, header[4], payload))
}
