//! One-off move of sessions still running in tmux (older showrunner versions)
//! into hc. A running process can't change terminals, so each idle session's
//! tmux session is killed and the session recreated in hc, resuming its
//! conversation. The only tmux code left; delete once nobody runs tmux
//! sessions any more.

use std::collections::HashMap;
use std::process::Command;
use std::thread::sleep;
use std::time::Duration;

use anyhow::{Context, Result};

use crate::agent::AgentKind;
use crate::config::{self, Config, SessionRecord};
use crate::{ops, session};

#[derive(Default)]
pub struct MigrateReport {
    pub migrated: Vec<String>,
    /// `(ref, why)` of sessions left running in tmux.
    pub skipped: Vec<(String, String)>,
    pub failures: Vec<String>,
}

pub fn migrate(cfg: &Config) -> Result<MigrateReport> {
    let mut report = MigrateReport::default();
    // Fail before killing anything when hc isn't usable.
    let in_hc = session::list_sessions().context("hc is not reachable")?;
    let records = config::load_sessions();
    let current = current_tmux_session();
    let conversations_by_dir = cwd_scoped_sessions_by_dir(&records);

    for name in tmux_sessions() {
        let Some(record) = records.get(&name) else {
            report.skipped.push((name, "no saved record".into()));
            continue;
        };
        let reference = format!(
            "{}/{}/{}",
            record.project_name, record.task_name, record.session_name
        );
        let mut record = record.clone();
        if record.claude_session_id.is_none() {
            record.claude_session_id = tmux_env(&name, "CM_CLAUDE_SESSION");
        }

        let skip_reason = if current.as_deref() == Some(name.as_str()) {
            Some("this session (run migrate from outside it)".to_string())
        } else if in_hc.iter().any(|s| s.name == name) {
            Some("already running in hc".to_string())
        } else if resumes_latest_in_dir(&record)
            && conversations_by_dir
                .get(&work_dir(&record))
                .is_some_and(|&n| n > 1)
        {
            Some(
                "shares its folder with other sessions and would resume the folder's \
                 latest conversation, maybe not its own"
                    .to_string(),
            )
        } else {
            busy_reason(&name, record.agent_kind())
        };
        if let Some(why) = skip_reason {
            report.skipped.push((reference, why));
            continue;
        }

        let _ = Command::new("tmux")
            .args(["kill-session", "-t", &name])
            .output();
        if let Some(id) = &record.claude_session_id {
            config::set_session_record_claude_session_id(&name, id);
        }
        let recreated = if session::is_adhoc_marker(&record.task_name) {
            session::recreate_adhoc_session(&name, &record).map(|_| true)
        } else {
            let project = cfg.projects.iter().find(|p| p.path == record.project_path);
            ops::recreate_task_session(project, &name, &record)
        };
        match recreated {
            Ok(true) => report.migrated.push(reference),
            Ok(false) => report
                .failures
                .push(format!("{reference}: its branch is gone, record dropped")),
            Err(e) => report.failures.push(format!("{reference}: {e}")),
        }
    }
    Ok(report)
}

/// Why the session can't move now: its agent is working or waits on a
/// dialog. `None` when it's idle (or its agent already ended).
fn busy_reason(name: &str, agent: AgentKind) -> Option<String> {
    match tmux_env(name, "CM_STATUS").as_deref() {
        Some("running") => return Some("working".into()),
        Some("waiting_permission") => return Some("waiting for you".into()),
        Some(_) => return None,
        None => {}
    }
    let before = capture(name)?;
    sleep(Duration::from_millis(1500));
    let after = capture(name)?;
    if before != after {
        Some("working".into())
    } else if session::detect_attention_dialog(&after, agent) {
        Some("waiting for you".into())
    } else {
        None
    }
}

/// Whether recreating resumes "the latest conversation in the folder" rather
/// than this session's own.
fn resumes_latest_in_dir(record: &SessionRecord) -> bool {
    record.agent_kind() != AgentKind::Claude || record.claude_session_id.is_none()
}

fn work_dir(record: &SessionRecord) -> String {
    if record.use_worktree {
        session::worktree_dir(
            &record.project_name,
            &record.task_name,
            &record.session_name,
        )
        .to_string_lossy()
        .to_string()
    } else {
        record.project_path.clone()
    }
}

/// How many recorded sessions keep conversations in each folder.
fn cwd_scoped_sessions_by_dir(records: &HashMap<String, SessionRecord>) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for record in records.values().filter(|r| !r.archived) {
        *counts.entry(work_dir(record)).or_insert(0) += 1;
    }
    counts
}

pub(crate) fn tmux_sessions() -> Vec<String> {
    tmux(&["list-sessions", "-F", "#{session_name}"])
        .map(|out| {
            out.lines()
                .filter(|name| name.starts_with("cm__"))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn tmux_env(name: &str, var: &str) -> Option<String> {
    let line = tmux(&["show-environment", "-t", name, var])?;
    line.trim()
        .split_once('=')
        .map(|(_, value)| value.to_string())
}

fn capture(name: &str) -> Option<String> {
    tmux(&["capture-pane", "-p", "-t", &format!("{name}:0")])
}

fn current_tmux_session() -> Option<String> {
    let pane = std::env::var("TMUX_PANE").ok()?;
    tmux(&["display-message", "-p", "-t", &pane, "#S"]).map(|s| s.trim().to_string())
}

fn tmux(args: &[&str]) -> Option<String> {
    let out = Command::new("tmux").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).to_string())
}
