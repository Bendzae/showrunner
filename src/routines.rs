//! Routines: shell commands, or agent prompts each started in a new adhoc
//! session, run on a schedule. A scheduler in its own hc terminal runs them
//! (`showrunner routine scheduler`) and is the only writer of their state.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

use anyhow::{Result, anyhow, bail};
use chrono::{DateTime, Datelike, Days, Local, NaiveTime, TimeDelta, Weekday};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::cli::parse_args;
use crate::config::{self, Config, Routine};
use crate::session::{self, shell_escape};
use crate::{hc, ops};

/// On the scheduler's terminal.
const LABEL: &str = "showrunner.routines";
/// Herdr shows the scheduler's terminal as this space and tab.
pub const SPACE: &str = "cm__routines";
pub const TAB: &str = "cm__routines__scheduler";
const TICK: Duration = Duration::from_secs(5);
/// A prompt routine's newest sessions stay; older ones end when it runs again.
const KEEP_RUNS: usize = 3;

#[derive(Debug, Clone, PartialEq)]
pub enum Schedule {
    Every(TimeDelta),
    /// On these weekdays (Monday first) at this time.
    At {
        days: [bool; 7],
        time: NaiveTime,
    },
}

const SCHEDULE_HELP: &str =
    "`every 5m` (m, h or d), `daily 09:00`, `weekdays 09:00`, `weekends 10:00` or `mon,thu 09:00`";

impl Schedule {
    pub fn parse(text: &str) -> Result<Self> {
        let invalid = || anyhow!("unknown schedule '{text}': use {SCHEDULE_HELP}");
        match text.split_whitespace().collect::<Vec<_>>().as_slice() {
            ["every", amount] => {
                let unit = amount.chars().last().ok_or_else(invalid)?;
                let n: i64 = amount[..amount.len() - unit.len_utf8()]
                    .parse()
                    .map_err(|_| invalid())?;
                if n < 1 {
                    return Err(invalid());
                }
                Ok(Schedule::Every(match unit {
                    'm' => TimeDelta::minutes(n),
                    'h' => TimeDelta::hours(n),
                    'd' => TimeDelta::days(n),
                    _ => return Err(invalid()),
                }))
            }
            [days, time] => {
                let time = NaiveTime::parse_from_str(time, "%H:%M").map_err(|_| invalid())?;
                let days = match *days {
                    "daily" => [true; 7],
                    "weekdays" => [true, true, true, true, true, false, false],
                    "weekends" => [false, false, false, false, false, true, true],
                    list => {
                        let mut days = [false; 7];
                        for day in list.split(',') {
                            let day: Weekday = day.parse().map_err(|_| invalid())?;
                            days[day.num_days_from_monday() as usize] = true;
                        }
                        days
                    }
                };
                Ok(Schedule::At { days, time })
            }
            _ => Err(invalid()),
        }
    }

    /// When it is first due after `after`.
    pub fn next_after(&self, after: DateTime<Local>) -> DateTime<Local> {
        match self {
            Schedule::Every(interval) => after + *interval,
            Schedule::At { days, time } => (0..=7)
                .filter_map(|i| after.date_naive().checked_add_days(Days::new(i)))
                .filter(|date| days[date.weekday().num_days_from_monday() as usize])
                .filter_map(|date| date.and_time(*time).and_local_timezone(Local).earliest())
                .find(|at| *at > after)
                // Only a time skipped by a clock change gets here.
                .unwrap_or(after + TimeDelta::days(1)),
        }
    }
}

/// What the scheduler knows about a routine.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct RoutineState {
    /// What its next run counts from: its last run, or when the scheduler
    /// first saw it or saw it resumed.
    pub since: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<i64>,
    /// "ok", "exit 1", "started <session>", "failed: …".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub failed: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub running: bool,
    /// A prompt routine's sessions, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runs: Vec<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

type States = HashMap<String, RoutineState>;

fn dir() -> PathBuf {
    config::base_dir().join("routines")
}

pub fn state_path() -> PathBuf {
    dir().join("state.json")
}

fn load_state() -> States {
    fs::read_to_string(state_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_state(states: &States) {
    let path = state_path();
    let temp = path.with_extension("json.tmp");
    let _ = fs::create_dir_all(dir());
    if let Ok(text) = serde_json::to_string_pretty(states)
        && fs::write(&temp, text).is_ok()
    {
        let _ = fs::rename(&temp, &path);
    }
}

/// `routine run` leaves one of these for the scheduler.
fn request_path(name: &str) -> PathBuf {
    dir().join("requests").join(session::sanitize(name))
}

fn at(timestamp: i64) -> DateTime<Local> {
    DateTime::from_timestamp(timestamp, 0).map_or_else(Local::now, |t| t.with_timezone(&Local))
}

fn when(time: DateTime<Local>) -> String {
    let format = if time.date_naive() == Local::now().date_naive() {
        "%H:%M"
    } else {
        "%a %d %b %H:%M"
    };
    time.format(format).to_string()
}

fn scheduler_terminal() -> Option<hc::Terminal> {
    hc::list(&[(LABEL, "scheduler")]).ok()?.into_iter().next()
}

/// Start the scheduler in its terminal unless it runs. Returns whether it was started.
pub fn ensure_scheduler() -> Result<bool> {
    if scheduler_terminal().is_some() {
        return Ok(false);
    }
    for old in hc::list_all(&[(LABEL, "scheduler")])? {
        hc::remove(&old.address);
    }
    let exe = std::env::current_exe()?;
    let unset: String = session::NESTING_ENV
        .iter()
        .map(|var| format!("-u {var} "))
        .collect();
    let data = std::env::var("SHOWRUNNER_HOME")
        .map(|home| format!("SHOWRUNNER_HOME={} ", shell_escape(&home)))
        .unwrap_or_default();
    let line = format!(
        "exec env {unset}{data}{} routine scheduler",
        shell_escape(&exe.to_string_lossy())
    );
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    hc::run(
        &home.to_string_lossy(),
        Some(&line),
        &[
            (LABEL, "scheduler"),
            ("herdr.space", SPACE),
            ("herdr.tab", TAB),
        ],
    )?;
    Ok(true)
}

/// macOS wakes up now and then while asleep (Power Nap, network upkeep) and
/// runs programs for a few seconds, without graphics: a dark wake. Routines
/// wait for a real wake.
fn asleep() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let Ok(out) = Command::new("ioreg")
        .args(["-r", "-n", "IOPMrootDomain", "-d", "1"])
        .output()
    else {
        return false;
    };
    const GRAPHICS: u32 = 2;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("\"System Capabilities\" = ")?
                .parse::<u32>()
                .ok()
        })
        .is_some_and(|capabilities| capabilities & GRAPHICS == 0)
}

/// The scheduler's loop. A newer showrunner binary takes over once nothing runs.
fn scheduler() -> Result<()> {
    let own = std::env::var("HC_TERMINAL_ID").ok();
    if let Some(other) = scheduler_terminal().filter(|t| Some(&t.address) != own.as_ref()) {
        bail!("the routine scheduler already runs in {}", other.address);
    }
    let exe = std::env::current_exe()?;
    let mut built = modified(&exe);
    let state = Arc::new(Mutex::new(load_state()));
    {
        // Runs a stopped scheduler left behind are over.
        let mut states = state.lock().unwrap();
        for s in states.values_mut() {
            s.running = false;
        }
        save_state(&states);
    }
    println!(
        "Runs the routines in {} on schedule; their output shows here. Ctrl-C stops.",
        Config::config_path().display()
    );
    let mut paused = HashSet::new();
    loop {
        let idle = !state.lock().unwrap().values().any(|s| s.running);
        if idle && replaced(&exe, built) {
            println!("showrunner was updated: restarting");
            let error = Command::new(&exe).args(std::env::args_os().skip(1)).exec();
            println!("could not restart: {error}");
            built = modified(&exe);
        }
        tick(&state, &mut paused);
        thread::sleep(TICK);
    }
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Whether the binary changed since `built`, and was written a while ago (not still being copied).
fn replaced(exe: &Path, built: Option<SystemTime>) -> bool {
    let Some(now) = modified(exe) else {
        return false;
    };
    Some(now) != built && now.elapsed().is_ok_and(|age| age > Duration::from_secs(3))
}

fn tick(state: &Arc<Mutex<States>>, paused: &mut HashSet<String>) {
    let Ok(cfg) = Config::load() else {
        return;
    };
    let now = Local::now();
    let mut due = Vec::new();
    {
        let mut states = state.lock().unwrap();
        let count = states.len();
        states.retain(|name, _| cfg.routines.iter().any(|r| &r.name == name));
        let mut changed = states.len() != count;
        for routine in &cfg.routines {
            let s = states.entry(routine.name.clone()).or_insert_with(|| {
                changed = true;
                RoutineState {
                    since: now.timestamp(),
                    ..Default::default()
                }
            });
            if routine.paused {
                paused.insert(routine.name.clone());
                continue;
            }
            // Resumed: counted from now, without catching up.
            if paused.remove(&routine.name) {
                s.since = now.timestamp();
                changed = true;
            }
            if s.running {
                continue;
            }
            let scheduled = Schedule::parse(&routine.schedule)
                .is_ok_and(|schedule| schedule.next_after(at(s.since)) <= now);
            if scheduled || request_path(&routine.name).exists() {
                due.push(routine.clone());
            }
        }
        if changed {
            save_state(&states);
        }
    }
    if due.is_empty() || asleep() {
        return;
    }
    for routine in due {
        let _ = fs::remove_file(request_path(&routine.name));
        start(routine, state.clone());
    }
}

fn update(state: &Mutex<States>, name: &str, change: impl FnOnce(&mut RoutineState)) {
    let mut states = state.lock().unwrap();
    if let Some(s) = states.get_mut(name) {
        change(s);
        save_state(&states);
    }
}

fn start(routine: Routine, state: Arc<Mutex<States>>) {
    let now = Local::now();
    update(&state, &routine.name, |s| {
        s.since = now.timestamp();
        s.last_run = Some(now.timestamp());
        s.running = true;
    });
    thread::spawn(move || {
        let (result, failed, output) = match &routine.command {
            Some(command) => match run_command(command) {
                Ok((Some(0), output)) => ("ok".to_string(), false, output),
                Ok((code, output)) => (
                    code.map_or("killed".to_string(), |c| format!("exit {c}")),
                    true,
                    output,
                ),
                Err(e) => (format!("failed: {e}"), true, String::new()),
            },
            None => match start_session(&routine, now) {
                Ok(cm_name) => {
                    let ended = {
                        let mut states = state.lock().unwrap();
                        let runs = &mut states.entry(routine.name.clone()).or_default().runs;
                        runs.push(cm_name.clone());
                        let extra = runs.len().saturating_sub(KEEP_RUNS);
                        runs.drain(..extra).collect::<Vec<_>>()
                    };
                    for old in ended {
                        let _ = ops::kill_session(&old);
                    }
                    (
                        format!("started {}", ref_of(&cm_name)),
                        false,
                        String::new(),
                    )
                }
                Err(e) => (format!("failed: {e:#}"), true, String::new()),
            },
        };
        print!("{}", report(&routine.name, now, &result, failed, &output));
        update(&state, &routine.name, |s| {
            s.running = false;
            s.failed = failed;
            s.last_result = Some(result);
        });
    });
}

/// Its exit code (none: killed by a signal) and output, stderr included.
fn run_command(command: &str) -> Result<(Option<i32>, String)> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let out = Command::new("sh")
        .arg("-c")
        .arg(format!("exec 2>&1\n{command}"))
        .current_dir(home)
        .stdin(Stdio::null())
        .output()?;
    Ok((
        out.status.code(),
        String::from_utf8_lossy(&out.stdout).trim_end().to_string(),
    ))
}

/// A new adhoc session in the routine's project, starting on its prompt.
fn start_session(routine: &Routine, now: DateTime<Local>) -> Result<String> {
    let cfg = Config::load()?;
    let name = routine.project.as_deref().unwrap_or_default();
    let project = cfg
        .projects
        .iter()
        .find(|p| p.name == name)
        .ok_or_else(|| anyhow!("no project '{name}'"))?;
    let agent = ops::resolve_agent(&cfg, routine.agent.as_deref())?;
    let live = session::list_sessions()?;
    let taken = |run: &str| {
        let cm_name = session::build_session_name(&project.name, session::ADHOC_MARKER, run);
        live.iter().any(|s| s.name == cm_name)
    };
    let mut run = format!("{}-{}", routine.name, now.format("%m%d-%H%M"));
    if taken(&run) {
        run = format!("{}-{}", routine.name, now.format("%m%d-%H%M%S"));
    }
    ops::create_adhoc_session(&cfg, project, &run, agent, routine.prompt.as_deref())
}

fn ref_of(cm_name: &str) -> String {
    cm_name.trim_start_matches("cm__").replace("__", "/")
}

/// What the scheduler's terminal shows for a run: nothing for a quiet success.
fn report(name: &str, at: DateTime<Local>, result: &str, failed: bool, output: &str) -> String {
    let time = at.format("%H:%M");
    let lines: Vec<&str> = output.lines().collect();
    let outcome = if failed {
        format!(" ({result})")
    } else {
        String::new()
    };
    match lines.as_slice() {
        [] if failed => format!("{time} {name}: {result}\n"),
        [] if result == "ok" => String::new(),
        [] => format!("{time} {name}: {result}\n"),
        [line] => format!("{time} {name}: {line}{outcome}\n"),
        lines => {
            let body: String = lines.iter().map(|l| format!("  {l}\n")).collect();
            format!("{time} {name}:{outcome}\n{body}")
        }
    }
}

/// The routines for `list --json` and the Herdr tree.
pub fn listing(cfg: &Config) -> Value {
    let states = load_state();
    let routines: Vec<Value> = cfg
        .routines
        .iter()
        .map(|r| {
            let s = states.get(&r.name).cloned().unwrap_or_default();
            let next = next_run(r, Some(&s));
            json!({
                "name": r.name,
                "schedule": r.schedule,
                "command": r.command,
                "project": r.project,
                "prompt": r.prompt,
                "agent": r.agent,
                "paused": r.paused,
                "next_run": next.map(|t| t.timestamp()),
                "last_run": s.last_run,
                "last_result": s.last_result,
                "failed": s.failed,
                "running": s.running,
                "runs": s.runs,
                "error": Schedule::parse(&r.schedule).err().map(|e| e.to_string()),
            })
        })
        .collect();
    json!({ "space": SPACE, "tab": TAB, "routines": routines })
}

const USAGE: &str = "usage: routine list [--json] | add <name> <schedule> (--command <cmd> | \
     --project <p> --prompt <text> [--agent <id>]) | edit <name> [--name <n>] [--schedule <s>] \
     [--command <cmd>] [--project <p>] [--prompt <text>] [--agent <id>] | \
     pause|resume|run <name> | delete <name> --yes | start | scheduler";

pub fn cmd_routine(args: &[String]) -> Result<()> {
    let rest = args.get(1..).unwrap_or_default();
    match args.first().map(String::as_str) {
        Some("list") => list(rest),
        Some("add") => add(rest),
        Some("edit") => edit(rest),
        Some("pause") => set_paused(rest, true),
        Some("resume") => set_paused(rest, false),
        Some("run") => run_now(rest),
        Some("delete") => delete(rest),
        Some("start") => {
            let started = ensure_scheduler()?;
            println!(
                "{}",
                if started {
                    "started the routine scheduler"
                } else {
                    "the routine scheduler runs"
                }
            );
            Ok(())
        }
        Some("scheduler") => scheduler(),
        _ => bail!("{USAGE}"),
    }
}

const FIELDS: [&str; 6] = ["name", "schedule", "command", "project", "prompt", "agent"];

/// Check a routine before it's saved; `old` is the name it had (on edit).
fn validate(cfg: &Config, routine: &Routine, old: Option<&str>) -> Result<()> {
    let name = routine.name.trim();
    if session::sanitize(name).is_empty() {
        bail!("a routine needs a name");
    }
    let key = |n: &str| session::sanitize(n).to_lowercase();
    if cfg
        .routines
        .iter()
        .any(|r| Some(r.name.as_str()) != old && key(&r.name) == key(name))
    {
        bail!("there is a routine called '{name}' already");
    }
    Schedule::parse(&routine.schedule)?;
    match (&routine.command, &routine.project, &routine.prompt) {
        (Some(command), None, None) if !command.trim().is_empty() => {}
        (None, Some(project), Some(prompt)) if !prompt.trim().is_empty() => {
            if !cfg.projects.iter().any(|p| &p.name == project) {
                bail!("no project '{project}'");
            }
            ops::resolve_agent(cfg, routine.agent.as_deref())?;
        }
        _ => bail!("a routine runs either --command <cmd>, or --prompt <text> in --project <p>"),
    }
    Ok(())
}

fn find<'a>(cfg: &'a mut Config, name: &str) -> Result<&'a mut Routine> {
    cfg.routines
        .iter_mut()
        .find(|r| r.name == name)
        .ok_or_else(|| anyhow!("no routine '{name}' (`showrunner routine list`)"))
}

/// When it runs next, as the scheduler counts (none while paused).
fn next_run(routine: &Routine, state: Option<&RoutineState>) -> Option<DateTime<Local>> {
    let schedule = Schedule::parse(&routine.schedule).ok()?;
    let since = state
        .filter(|s| s.since > 0)
        .map_or_else(Local::now, |s| at(s.since));
    (!routine.paused).then(|| schedule.next_after(since))
}

fn next_run_text(routine: &Routine) -> String {
    match next_run(routine, load_state().get(&routine.name)) {
        Some(next) => format!("next run {}", when(next)),
        None => String::new(),
    }
}

fn add(args: &[String]) -> Result<()> {
    let (positional, flags) = parse_args(args, &FIELDS[2..], &[])?;
    let [name, schedule] = positional.as_slice() else {
        bail!(
            "usage: routine add <name> <schedule> (--command <cmd> | --project <p> --prompt <text> [--agent <id>])\n\
               schedules: {SCHEDULE_HELP}"
        );
    };
    let routine = Routine {
        name: name.trim().to_string(),
        schedule: schedule.trim().to_string(),
        command: flags.get("command").cloned(),
        project: flags.get("project").cloned(),
        prompt: flags.get("prompt").cloned(),
        agent: flags.get("agent").cloned(),
        paused: false,
    };
    let mut cfg = Config::load()?;
    validate(&cfg, &routine, None)?;
    let next = next_run_text(&routine);
    cfg.routines.push(routine.clone());
    cfg.save()?;
    ensure_scheduler()?;
    println!("added routine {}: {next}", routine.name);
    Ok(())
}

fn edit(args: &[String]) -> Result<()> {
    let (positional, flags) = parse_args(args, &FIELDS, &[])?;
    let [name] = positional.as_slice() else {
        bail!(
            "usage: routine edit <name> [--name <n>] [--schedule <s>] [--command <cmd>] [--project <p>] [--prompt <text>] [--agent <id>]"
        );
    };
    let mut cfg = Config::load()?;
    let mut routine = find(&mut cfg, name)?.clone();
    if let Some(new) = flags.get("name") {
        routine.name = new.trim().to_string();
    }
    if let Some(schedule) = flags.get("schedule") {
        routine.schedule = schedule.trim().to_string();
    }
    // A command and a prompt exclude each other: giving one replaces the other.
    if let Some(command) = flags.get("command") {
        routine.command = Some(command.clone());
        routine.project = None;
        routine.prompt = None;
        routine.agent = None;
    }
    for (field, value) in [
        (&mut routine.project, flags.get("project")),
        (&mut routine.prompt, flags.get("prompt")),
        (&mut routine.agent, flags.get("agent")),
    ] {
        if let Some(value) = value {
            *field = Some(value.clone());
            routine.command = None;
        }
    }
    validate(&cfg, &routine, Some(name))?;
    *find(&mut cfg, name)? = routine.clone();
    cfg.save()?;
    println!(
        "updated routine {}: {}",
        routine.name,
        next_run_text(&routine)
    );
    Ok(())
}

fn one_name(args: &[String], usage: &str) -> Result<String> {
    match args {
        [name] => Ok(name.clone()),
        _ => bail!("usage: routine {usage}"),
    }
}

fn set_paused(args: &[String], paused: bool) -> Result<()> {
    let name = one_name(
        args,
        if paused {
            "pause <name>"
        } else {
            "resume <name>"
        },
    )?;
    let mut cfg = Config::load()?;
    find(&mut cfg, &name)?.paused = paused;
    cfg.save()?;
    if !paused {
        ensure_scheduler()?;
    }
    println!(
        "{} routine {name}",
        if paused { "paused" } else { "resumed" }
    );
    Ok(())
}

fn run_now(args: &[String]) -> Result<()> {
    let name = one_name(args, "run <name>")?;
    let mut cfg = Config::load()?;
    find(&mut cfg, &name)?;
    let path = request_path(&name);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, "")?;
    ensure_scheduler()?;
    let running = load_state().get(&name).is_some_and(|s| s.running);
    println!(
        "routine {name} {}",
        if running {
            "runs again once its current run ends"
        } else {
            "runs now"
        }
    );
    Ok(())
}

fn delete(args: &[String]) -> Result<()> {
    let (positional, flags) = parse_args(args, &[], &["yes"])?;
    let [name] = positional.as_slice() else {
        bail!("usage: routine delete <name> --yes");
    };
    if !flags.contains_key("yes") {
        bail!("pass --yes to delete routine {name} (its sessions stay)");
    }
    let mut cfg = Config::load()?;
    find(&mut cfg, name)?;
    cfg.routines.retain(|r| &r.name != name);
    cfg.save()?;
    let _ = fs::remove_file(request_path(name));
    println!("deleted routine {name}");
    Ok(())
}

fn list(args: &[String]) -> Result<()> {
    let (_, flags) = parse_args(args, &[], &["json"])?;
    let cfg = Config::load()?;
    if flags.contains_key("json") {
        println!("{}", serde_json::to_string_pretty(&listing(&cfg))?);
        return Ok(());
    }
    match scheduler_terminal() {
        Some(t) => println!("scheduler: runs in {}", t.address),
        None => println!("scheduler: not running (`showrunner routine start`)"),
    }
    let states = load_state();
    for r in &cfg.routines {
        let s = states.get(&r.name).cloned().unwrap_or_default();
        let what = match (&r.command, &r.project) {
            (Some(command), _) => format!("command: {command}"),
            (None, Some(project)) => format!(
                "prompt in {project}: {}",
                r.prompt
                    .as_deref()
                    .unwrap_or_default()
                    .lines()
                    .next()
                    .unwrap_or_default()
            ),
            _ => "nothing to run".to_string(),
        };
        println!(
            "\n{}  {}{}",
            r.name,
            r.schedule,
            if r.paused { "  (paused)" } else { "" }
        );
        println!("  {what}");
        let mut facts = Vec::new();
        if s.running {
            facts.push("running".to_string());
        }
        if let Some(last) = s.last_run {
            facts.push(format!(
                "last run {} {}",
                when(at(last)),
                s.last_result.as_deref().unwrap_or("")
            ));
        }
        if let Some(next) = next_run(r, Some(&s)) {
            facts.push(format!("next {}", when(next)));
        }
        if !facts.is_empty() {
            println!("  {}", facts.join(" · "));
        }
    }
    if cfg.routines.is_empty() {
        println!("no routines (`showrunner routine add`)");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn local(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, h, min, 0).unwrap()
    }

    #[test]
    fn parses_intervals() {
        assert_eq!(
            Schedule::parse("every 5m").unwrap(),
            Schedule::Every(TimeDelta::minutes(5))
        );
        assert_eq!(
            Schedule::parse(" every  2h ").unwrap(),
            Schedule::Every(TimeDelta::hours(2))
        );
        assert_eq!(
            Schedule::parse("every 1d").unwrap(),
            Schedule::Every(TimeDelta::days(1))
        );
        for bad in [
            "every 0m",
            "every 5",
            "every m",
            "every 5s",
            "every 5ü",
            "hourly",
            "",
        ] {
            assert!(Schedule::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn parses_days_and_times() {
        let Schedule::At { days, time } = Schedule::parse("mon,thu 9:30").unwrap() else {
            panic!()
        };
        assert_eq!(days, [true, false, false, true, false, false, false]);
        assert_eq!(time, NaiveTime::from_hms_opt(9, 30, 0).unwrap());
        assert!(Schedule::parse("daily 25:00").is_err());
        assert!(Schedule::parse("someday 09:00").is_err());
    }

    #[test]
    fn next_daily_run_is_today_or_tomorrow() {
        let daily = Schedule::parse("daily 09:00").unwrap();
        assert_eq!(
            daily.next_after(local(2026, 11, 13, 8, 0)),
            local(2026, 11, 13, 9, 0)
        );
        assert_eq!(
            daily.next_after(local(2026, 11, 13, 9, 0)),
            local(2026, 11, 14, 9, 0)
        );
    }

    #[test]
    fn weekdays_skip_the_weekend() {
        // 2026-11-13 is a Friday.
        let weekdays = Schedule::parse("weekdays 09:00").unwrap();
        assert_eq!(
            weekdays.next_after(local(2026, 11, 13, 10, 0)),
            local(2026, 11, 16, 9, 0)
        );
        let mondays = Schedule::parse("mon 09:00").unwrap();
        assert_eq!(
            mondays.next_after(local(2026, 11, 16, 9, 0)),
            local(2026, 11, 23, 9, 0)
        );
    }

    #[test]
    fn missed_runs_come_due_once() {
        let hourly = Schedule::parse("every 1h").unwrap();
        let last = local(2026, 11, 12, 18, 0);
        assert!(hourly.next_after(last) <= local(2026, 11, 13, 8, 0));
    }

    #[test]
    fn quiet_success_reports_nothing() {
        let t = local(2026, 11, 13, 9, 5);
        assert_eq!(report("x", t, "ok", false, ""), "");
        assert_eq!(report("x", t, "exit 1", true, ""), "09:05 x: exit 1\n");
        assert_eq!(report("x", t, "ok", false, "hi"), "09:05 x: hi\n");
        assert_eq!(
            report("x", t, "exit 2", true, "a\nb"),
            "09:05 x: (exit 2)\n  a\n  b\n"
        );
    }
}
