//! Reviewing a task's or session's diff in difit or hunk, and turning the
//! human's comments into a prompt for the agent. Shared by the TUI and
//! `showrunner review`.

use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};

use crate::config::Task;
use crate::session::{self, LiveSession};

/// What to review and who hears about it.
pub struct Review {
    pub cwd: String,
    pub difit_args: Vec<String>,
    pub hunk_args: Vec<String>,
    /// Sessions the comments can go to, as `(session name, display name)`.
    pub candidates: Vec<(String, String)>,
    pub description: String,
}

/// A task's branch against its base, as the PR would show it. Every session
/// of the task can receive the comments.
pub fn for_task(
    project_name: &str,
    project_path: &str,
    task: &Task,
    sessions: &[LiveSession],
) -> Review {
    let base = task.base_branch();
    let base_ref = session::resolve_base_ref(project_path, base);
    let candidates = session::sessions_for_task(project_name, &task.name, sessions)
        .into_iter()
        .map(|s| (s.name, s.session_name))
        .collect();
    // difit: `difit <target> <base> --merge-base` diffs against
    // merge-base(branch, base), so main's commits since the fork point stay
    // out. hunk: the three-dot range is git's equivalent.
    Review {
        cwd: project_path.to_string(),
        difit_args: vec![
            task.branch.clone(),
            base_ref.clone(),
            "--merge-base".to_string(),
        ],
        hunk_args: vec!["diff".to_string(), format!("{base_ref}...{}", task.branch)],
        candidates,
        description: format!("{} vs {base}", task.branch),
    }
}

/// A session's uncommitted changes (untracked files included).
pub fn for_session(project_path: &str, session: &LiveSession) -> Review {
    let cwd = session
        .worktree_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| project_path.to_string());
    Review {
        cwd,
        difit_args: vec![".".to_string(), "--include-untracked".to_string()],
        hunk_args: vec!["diff".to_string()],
        candidates: vec![(session.name.clone(), session.session_name.clone())],
        description: format!("uncommitted changes in {}", session.session_name),
    }
}

/// The prompt forwarded to an agent session carrying review comments;
/// `comments` is the tool's raw comment block.
pub fn prompt(comments: &str) -> String {
    format!(
        "The following code review comments were left during review. \
         Please address them:\n\n{comments}"
    )
}

/// Run difit until its browser review closes; the comments left, if any.
pub fn run_difit(cwd: &str, args: &[String]) -> Result<Option<String>> {
    let out = difit_command(args)
        .current_dir(cwd)
        .output()
        .context("difit failed to launch (need difit or npx on PATH)")?;
    Ok(extract_difit_comments(&String::from_utf8_lossy(
        &out.stdout,
    )))
}

/// Run hunk on this terminal until it exits; the human's comments, if any.
///
/// hunk's review session is live-only: its comments are queryable while it
/// runs but vanish when it exits, and it prints none. So a thread polls the
/// live session and keeps the latest snapshot. A comment added in the last
/// fraction of a second before quitting may be missed.
pub fn run_hunk(cwd: &str, args: &[String]) -> Result<Option<String>> {
    let stop = Arc::new(AtomicBool::new(false));
    let latest: Arc<Mutex<Vec<HunkComment>>> = Arc::new(Mutex::new(Vec::new()));
    let poller = {
        let stop = stop.clone();
        let latest = latest.clone();
        let cwd = cwd.to_string();
        thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                if let Some(comments) = query_hunk_user_comments(&cwd) {
                    *latest.lock().unwrap() = comments;
                }
                for _ in 0..3 {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            }
        })
    };

    let status = hunk_command(args).current_dir(cwd).status();
    stop.store(true, Ordering::Relaxed);
    let _ = poller.join();
    status.context("hunk failed to launch (need hunk or npx on PATH)")?;

    let comments = latest.lock().unwrap().clone();
    Ok((!comments.is_empty()).then(|| format_hunk_comments(&comments)))
}

fn on_path(program: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(program).is_file()))
}

/// difit from `PATH`, else through `npx -y difit` (fetched on first use).
fn difit_command(args: &[String]) -> Command {
    let mut cmd = if on_path("difit") {
        Command::new("difit")
    } else {
        let mut c = Command::new("npx");
        c.args(["-y", "difit"]);
        c
    };
    cmd.args(args);
    cmd
}

/// hunk from `PATH`, else through `npx -y hunkdiff` (its npm package).
pub fn hunk_command(args: &[String]) -> Command {
    let mut cmd = if on_path("hunk") {
        Command::new("hunk")
    } else {
        let mut c = Command::new("npx");
        c.args(["-y", "hunkdiff"]);
        c
    };
    cmd.args(args);
    cmd
}

/// A single inline review note from hunk's live session (`hunk session comment
/// list --json`). Only the fields needed to forward the note are deserialized.
#[derive(Clone, serde::Deserialize)]
struct HunkComment {
    #[serde(rename = "filePath")]
    file_path: Option<String>,
    body: Option<String>,
    /// `[start, end]` line range on the new side; absent for pure deletions.
    #[serde(rename = "newRange")]
    new_range: Option<Vec<i64>>,
    /// `[start, end]` line range on the old side.
    #[serde(rename = "oldRange")]
    old_range: Option<Vec<i64>>,
}

/// The human's comments (`--type user`) in hunk's live session; `None` on any
/// failure (daemon down, session not yet registered), so the poller keeps its
/// previous snapshot.
fn query_hunk_user_comments(cwd: &str) -> Option<Vec<HunkComment>> {
    let args: Vec<String> = [
        "session", "comment", "list", "--repo", cwd, "--type", "user", "--json",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    // Null stdin so this background query can't contend for terminal input with
    // the foreground hunk.
    let out = hunk_command(&args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    #[derive(serde::Deserialize)]
    struct List {
        comments: Vec<HunkComment>,
    }
    serde_json::from_slice::<List>(&out.stdout)
        .ok()
        .map(|l| l.comments)
}

/// hunk comments as a `- file:line — body` block, like difit's.
fn format_hunk_comments(comments: &[HunkComment]) -> String {
    comments
        .iter()
        .map(|c| {
            let file = c.file_path.as_deref().unwrap_or("(unknown file)");
            let line = c
                .new_range
                .as_ref()
                .or(c.old_range.as_ref())
                .and_then(|r| r.first())
                .copied();
            let body = c.body.as_deref().unwrap_or("").trim();
            match line {
                Some(l) => format!("- {file}:{l} — {body}"),
                None => format!("- {file} — {body}"),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The review-comment block difit prints on exit; `None` when the session
/// left no comments (difit prints nothing then).
fn extract_difit_comments(stdout: &str) -> Option<String> {
    const MARKER: &str = "Comments from review session:";
    let idx = stdout.find(MARKER)?;
    // Back up to the start of the marker's line so the header is included.
    let line_start = stdout[..idx].rfind('\n').map(|n| n + 1).unwrap_or(0);
    Some(stdout[line_start..].trim_end().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_difit_comments_returns_none_without_marker() {
        assert_eq!(extract_difit_comments("server started\nbye"), None);
    }

    #[test]
    fn extract_difit_comments_captures_from_marker() {
        let out = "noise\nComments from review session:\n- fix this\n";
        let got = extract_difit_comments(out).unwrap();
        assert!(got.starts_with("Comments from review session:"));
        assert!(got.contains("- fix this"));
    }

    // Parse the exact shape `hunk session comment list --json` emits, then format
    // it into the comment block. Guards both the serde field renames and the
    // file:line rendering (incl. the oldRange-only / missing-line fallbacks).
    fn parse_hunk_comments(json: &str) -> Vec<HunkComment> {
        #[derive(serde::Deserialize)]
        struct List {
            comments: Vec<HunkComment>,
        }
        serde_json::from_str::<List>(json).unwrap().comments
    }

    #[test]
    fn format_hunk_comments_renders_file_line_and_body() {
        let json = r#"{"comments":[
            {"noteId":"u:1","source":"user","filePath":"src/f.txt","hunkIndex":0,
             "newRange":[2,2],"body":"Please rename this variable","editable":true},
            {"noteId":"u:2","source":"user","filePath":"src/g.txt",
             "oldRange":[10,12],"body":"Removed too much","editable":true}
        ]}"#;
        let comments = parse_hunk_comments(json);
        let out = format_hunk_comments(&comments);
        assert!(out.contains("- src/f.txt:2 — Please rename this variable"));
        // Falls back to oldRange when newRange is absent.
        assert!(out.contains("- src/g.txt:10 — Removed too much"));
        // Wrapped by the shared review prompt when forwarded.
        assert!(prompt(&out).contains("Please address them"));
    }

    #[test]
    fn format_hunk_comments_tolerates_missing_fields() {
        // A note with neither range nor file still renders without panicking.
        let comments = parse_hunk_comments(r#"{"comments":[{"body":"general note"}]}"#);
        let out = format_hunk_comments(&comments);
        assert!(out.contains("(unknown file) — general note"));
    }

    #[test]
    fn review_prompt_embeds_the_comments() {
        let prompt = prompt("- rename foo\n- drop bar");
        assert!(prompt.contains("- rename foo"));
        assert!(prompt.contains("- drop bar"));
        assert!(prompt.contains("Please address them"));
    }
}
