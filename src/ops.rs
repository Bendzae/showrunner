//! Task and session operations shared by the HTTP server and the CLI, so both
//! headless entry points create and delete things exactly like the TUI does.

use std::collections::HashSet;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::agent::AgentKind;
use crate::config::{self, Config, Project};
use crate::tmux;

/// The agent new sessions run: an explicit `--agent` value wins, else the
/// config's `default_agent`, else Claude.
pub fn resolve_agent(cfg: &Config, explicit: Option<&str>) -> Result<AgentKind> {
    match explicit {
        Some(id) => crate::agent::parse_agent_id(id),
        None => Ok(AgentKind::from_id(&cfg.default_agent).unwrap_or_default()),
    }
}

/// Create a session for a task and persist its record.
pub fn create_task_session(
    cfg: &Config,
    project: &Project,
    task_name: &str,
    branch: &str,
    session_name: String,
    use_worktree: bool,
    prompt: Option<&str>,
    agent: AgentKind,
) -> Result<String> {
    let tmux_name = tmux::create_session(
        &project.name,
        &project.path,
        task_name,
        branch,
        &session_name,
        use_worktree,
        &project.copy_patterns,
        &project.setup_commands,
        prompt,
        &cfg.startup_skills,
        agent,
    )?;

    config::add_session_record(
        &tmux_name,
        config::SessionRecord {
            project_name: project.name.clone(),
            project_path: project.path.clone(),
            task_name: task_name.to_string(),
            task_branch: branch.to_string(),
            session_name,
            use_worktree,
            archived: false,
            agent: agent.id().to_string(),
        },
    );

    Ok(tmux_name)
}

/// Create a task (branch + config entry) and its main session.
/// `branch` defaults to a branch name derived from the task name.
/// `base` sets the task's base branch (for stacking); a newly created task
/// branch starts from it instead of main.
/// Returns the task's branch and the main session's tmux name.
pub fn create_task(
    cfg: &Config,
    project: &Project,
    task_name: &str,
    branch: Option<&str>,
    base: Option<&str>,
    group: Option<&str>,
    prompt: Option<&str>,
    agent: AgentKind,
) -> Result<(String, String)> {
    let task_name = task_name.trim();
    if task_name.is_empty() {
        bail!("task name is required");
    }
    if tmux::is_adhoc_marker(task_name) {
        bail!("'adhoc' is a reserved task name");
    }
    if project.tasks.iter().any(|t| t.name == task_name) {
        bail!(
            "task '{task_name}' already exists in project '{}'",
            project.name
        );
    }

    let branch = branch
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| tmux::to_branch_name(task_name));
    if branch.is_empty() {
        bail!("task name produces an empty branch name");
    }
    if branch == "main" || branch == "master" {
        bail!("'{branch}' cannot be used as a task branch");
    }

    let base = base.map(str::trim).filter(|b| !b.is_empty());
    if let Some(base) = base {
        if base == branch {
            bail!("base branch can't be the task branch itself");
        }
        if !tmux::branch_exists(&project.path, base) {
            bail!(
                "base branch '{base}' does not exist in {} (create it first, or check the name)",
                project.path
            );
        }
    }

    if !tmux::branch_exists(&project.path, &branch) {
        tmux::create_task_branch(&project.path, &branch, base)?;
    }

    let (project_name, task, branch_for_config) =
        (project.name.clone(), task_name.to_string(), branch.clone());
    let base_for_config = base.map(str::to_string);
    let group_for_config = group.map(str::to_string);
    Config::modify(move |c| {
        c.add_task(&project_name, task.clone(), branch_for_config);
        c.set_task_base_branch(&project_name, &task, base_for_config);
        c.set_task_group(&project_name, &task, group_for_config);
    })?;

    let tmux_name = create_task_session(
        cfg,
        project,
        task_name,
        &branch,
        tmux::MAIN_SESSION.to_string(),
        true,
        prompt,
        agent,
    )?;

    Ok((branch, tmux_name))
}

/// Create an additional session on an existing task, numbered like the TUI does.
pub fn create_session(
    cfg: &Config,
    project: &Project,
    task_name: &str,
    branch: &str,
    use_worktree: bool,
    prompt: Option<&str>,
    agent: AgentKind,
) -> Result<String> {
    let sessions = tmux::list_sessions()?;
    let session_name = tmux::next_session_number(&project.name, task_name, &sessions).to_string();
    create_task_session(
        cfg,
        project,
        task_name,
        branch,
        session_name,
        use_worktree,
        prompt,
        agent,
    )
}

/// Delete a task: kill its sessions, remove their worktrees/branches, drop the
/// session records and the config entry.
pub fn delete_task(project: &Project, task_name: &str) -> Result<()> {
    let task = project
        .tasks
        .iter()
        .find(|t| t.name == task_name)
        .ok_or_else(|| anyhow::anyhow!("task '{task_name}' not found"))?;

    let sessions = tmux::list_sessions().unwrap_or_default();
    tmux::delete_task(
        &project.name,
        &project.path,
        &task.name,
        &task.branch,
        &sessions,
    );
    config::remove_task_session_records(&project.name, &task.name);

    let (project_name, task_name) = (project.name.clone(), task_name.to_string());
    Config::modify(move |c| {
        c.remove_task(&project_name, &task_name);
    })?;

    Ok(())
}

/// Whether a tmux session name belongs to a task's main session.
pub fn is_main_session_name(tmux_name: &str) -> bool {
    tmux_name.ends_with(&format!("__{}", tmux::MAIN_SESSION))
}

/// Kill a session, removing its worktree and per-session branch.
/// Main sessions are owned by their task — delete the task instead.
pub fn kill_session(tmux_name: &str) -> Result<()> {
    if is_main_session_name(tmux_name) {
        bail!("the main session can't be killed — delete the task instead");
    }

    let fallback = config::load_sessions()
        .get(tmux_name)
        .filter(|r| r.use_worktree)
        .map(|r| tmux::SessionCleanupInfo {
            project_path: r.project_path.clone(),
            worktree_path: tmux::worktree_dir(&r.project_name, &r.task_name, &r.session_name)
                .to_string_lossy()
                .to_string(),
            branch_name: Some(format!(
                "{}-{}",
                tmux::sanitize(&r.task_branch),
                tmux::sanitize(&r.session_name)
            )),
            task_branch: Some(r.task_branch.clone()),
        });

    tmux::kill_session_with_fallback(tmux_name, fallback)?;
    config::remove_session_record(tmux_name);
    Ok(())
}

/// Look up a project by name in the loaded config.
pub fn find_project<'a>(cfg: &'a Config, name: &str) -> Result<&'a Project> {
    cfg.projects
        .iter()
        .find(|p| p.name == name)
        .ok_or_else(|| anyhow::anyhow!("project '{name}' not found"))
}

/// What another machine needs to pick a session up: its task (recreated there
/// if missing) and the branch it works on, which `export_session` has pushed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionExport {
    pub project_name: String,
    pub task_name: String,
    pub task_branch: String,
    pub base_branch: Option<String>,
    pub group: Option<String>,
    pub session_name: String,
    pub agent: String,
    pub branch: String,
}

/// Commit whatever the session's worktree holds and push its branch, so the
/// session can be recreated from origin elsewhere.
pub fn export_session(cfg: &Config, tmux_name: &str) -> Result<SessionExport> {
    let record = config::load_sessions()
        .remove(tmux_name)
        .ok_or_else(|| anyhow::anyhow!("no session record for {tmux_name}"))?;
    if !record.use_worktree {
        bail!("sessions without a worktree can't be moved");
    }
    let worktree = tmux::worktree_dir(
        &record.project_name,
        &record.task_name,
        &record.session_name,
    )
    .to_string_lossy()
    .to_string();
    let branch = tmux::current_branch(&worktree)
        .ok_or_else(|| anyhow::anyhow!("could not read the branch of {worktree}"))?;

    if tmux::worktree_is_dirty(&worktree) {
        let message = format!(
            "Handoff: {}",
            tmux::next_commit_message(&worktree, &record.session_name)
        );
        tmux::commit_all(&worktree, &message)?;
    }
    tmux::push_branch(&record.project_path, &branch)?;

    let task = cfg.find_task(&record.project_name, &record.task_name);
    Ok(SessionExport {
        project_name: record.project_name,
        task_name: record.task_name,
        task_branch: record.task_branch,
        base_branch: task.and_then(|t| t.base_branch.clone()),
        group: task.and_then(|t| t.group.clone()),
        session_name: record.session_name,
        agent: record.agent,
        branch,
    })
}

/// Recreate an exported session here: register its task if needed, check out
/// its pushed branch in a fresh worktree and start the agent with `prompt`.
pub fn import_session(cfg: &Config, export: &SessionExport, prompt: &str) -> Result<String> {
    let project = find_project(cfg, &export.project_name)?;
    let agent = crate::agent::parse_agent_id(&export.agent)?;
    let sessions = tmux::list_sessions().unwrap_or_default();
    if !tmux::sessions_for_task(&project.name, &export.task_name, &sessions)
        .iter()
        .all(|s| s.session_name != tmux::sanitize(&export.session_name))
    {
        bail!(
            "session {}/{}/{} already exists here",
            project.name,
            export.task_name,
            export.session_name
        );
    }

    if !project.tasks.iter().any(|t| t.name == export.task_name) {
        let (project_name, task_name) = (project.name.clone(), export.task_name.clone());
        let (branch, base, group) = (
            export.task_branch.clone(),
            export.base_branch.clone(),
            export.group.clone(),
        );
        Config::modify(move |c| {
            c.add_task(&project_name, task_name.clone(), branch);
            c.set_task_base_branch(&project_name, &task_name, base);
            c.set_task_group(&project_name, &task_name, group);
        })?;
    }

    let tmux_name = tmux::create_session_with(
        &project.name,
        &project.path,
        &export.task_name,
        &export.task_branch,
        &export.session_name,
        true,
        &project.copy_patterns,
        &project.setup_commands,
        Some(prompt),
        &cfg.startup_skills,
        agent,
        tmux::Checkout::PushedBranch,
    )?;
    config::add_session_record(
        &tmux_name,
        config::SessionRecord {
            project_name: project.name.clone(),
            project_path: project.path.clone(),
            task_name: export.task_name.clone(),
            task_branch: export.task_branch.clone(),
            session_name: export.session_name.clone(),
            use_worktree: true,
            archived: false,
            agent: agent.id().to_string(),
        },
    );
    Ok(tmux_name)
}

/// Drop a session that now lives on another machine: kill it and remove its
/// worktree and record, but keep the branch (origin has it; a later move back
/// fast-forwards it).
pub fn release_session(tmux_name: &str) -> Result<()> {
    let record = config::load_sessions()
        .remove(tmux_name)
        .ok_or_else(|| anyhow::anyhow!("no session record for {tmux_name}"))?;
    let worktree = tmux::worktree_dir(
        &record.project_name,
        &record.task_name,
        &record.session_name,
    )
    .to_string_lossy()
    .to_string();
    tmux::remove_session_keep_branch(tmux_name, &record.project_path, &worktree);
    config::remove_session_record(tmux_name);
    Ok(())
}

/// Outcome of [`restore_sessions`]: refs recreated, and `ref: error` for those
/// that couldn't be.
#[derive(Debug, Default)]
pub struct RestoreReport {
    pub restored: Vec<String>,
    pub failures: Vec<String>,
}

/// Recreate saved sessions that are no longer in tmux (tmux died, the machine
/// rebooted). Whether to recreate or prune depends on the task still existing
/// in the config — not on tmux liveness — so sessions come back after a
/// restart, while those of deleted tasks are reaped instead of resurrected.
pub fn restore_sessions(cfg: &Config) -> RestoreReport {
    let mut report = RestoreReport::default();
    let saved = config::load_sessions();
    if saved.is_empty() {
        return report;
    }
    let live: Vec<tmux::TmuxSession> = tmux::list_sessions().unwrap_or_default();
    let live_names: HashSet<&str> = live.iter().map(|s| s.name.as_str()).collect();

    for (tmux_name, record) in &saved {
        if record.archived || live_names.contains(tmux_name.as_str()) {
            continue;
        }
        let reference = format!(
            "{}/{}/{}",
            record.project_name, record.task_name, record.session_name
        );

        if tmux::is_adhoc_marker(&record.task_name) {
            // Adhoc sessions are project-scoped: recreate while the project
            // exists, otherwise prune.
            if !cfg.project_exists(&record.project_path) {
                config::remove_session_record(tmux_name);
            } else {
                match tmux::recreate_adhoc_session(tmux_name, record) {
                    Ok(_) => report.restored.push(reference),
                    Err(e) => report.failures.push(format!("{reference}: {e}")),
                }
            }
            continue;
        }

        // Task-scoped: match by branch (+ project path) rather than the display
        // names, which can drift when the config is edited by hand.
        match cfg.find_task_by_branch(&record.project_path, &record.task_branch) {
            Some(_) => {
                if tmux::record_worktree_missing(record) {
                    config::remove_session_record(tmux_name);
                } else {
                    match tmux::recreate_session(tmux_name, record) {
                        Ok(_) => report.restored.push(reference),
                        Err(e) => report.failures.push(format!("{reference}: {e}")),
                    }
                }
            }
            None => {
                // The task is gone from the config: reap the orphan (worktree,
                // cached context, record); the git branch is kept.
                tmux::cleanup_orphan_session(record);
                config::remove_session_record(tmux_name);
            }
        }
    }
    report
}

/// PR details for a task branch, from the on-disk cache when it is younger than
/// `max_age`, else freshly from `gh` (and cached). Absence of a PR is cached
/// too, so branches without one don't cost a `gh` call per listing.
pub fn cached_pr_info(
    project_name: &str,
    project_path: &str,
    branch: &str,
    max_age: std::time::Duration,
) -> Option<tmux::PrInfo> {
    let path = config::pr_cache_path(project_name, branch);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Some(cached) = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        && cached["fetched_at"]
            .as_u64()
            .is_some_and(|t| now.saturating_sub(t) < max_age.as_secs())
    {
        return tmux::PrInfo::from_json(&cached["pr"]);
    }

    let info = tmux::get_pr_info(project_path, branch);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let entry = serde_json::json!({
        "fetched_at": now,
        "pr": info.as_ref().map(|i| i.to_json()),
    });
    let _ = std::fs::write(&path, entry.to_string());
    if let Some(info) = &info {
        let _ = std::fs::write(config::pr_url_path(project_name, branch), &info.url);
    }
    info
}
