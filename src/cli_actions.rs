//! CLI commands for the TUI's workflow actions (projects, groups, archiving,
//! git, review, run), so frontends other than the TUI (the Herdr mods) can
//! do everything the TUI does.

use std::io::{BufRead, Write};

use anyhow::{Result, bail};

use crate::cli::{
    current_session_name, parse_args, resolve_recorded_session, resolve_session, session_ref,
};
use crate::config::{self, Config, Project, Task};
use crate::ideas::{self, Change};
use crate::ops;
use crate::review;
use crate::session::{self, LiveSession};

pub fn cmd_project(args: &[String]) -> Result<()> {
    let rest = args.get(1..).unwrap_or_default();
    match args.first().map(String::as_str) {
        Some("add") => project_add(rest),
        Some("delete") => project_delete(rest),
        Some("move") => project_move(rest),
        Some("branches") => project_branches(rest),
        Some("checkout") => project_checkout(rest),
        Some("fetch") => project_fetch(rest),
        Some("set-run") => project_set_run(rest),
        _ => bail!(
            "usage: project add <path> [--name <n>] | project delete <project> --yes | \
             project move <project> up|down | project branches <project> | \
             project checkout <project> <branch> | project fetch <project> | \
             project set-run <project> [<command>]"
        ),
    }
}

pub fn cmd_group(args: &[String]) -> Result<()> {
    let rest = args.get(1..).unwrap_or_default();
    match args.first().map(String::as_str) {
        Some("rename") => group_rename(rest),
        Some("ungroup") => group_ungroup(rest),
        Some("move") => group_move(rest),
        _ => bail!(
            "usage: group rename <project> <group> <new name> | group ungroup <project> <group> | \
             group move <project> <group> up|down [--archived]"
        ),
    }
}

/// `task` subcommands beyond create/set-*/delete; `None` when `sub` is none of them.
pub fn task_action(sub: &str, args: &[String]) -> Option<Result<()>> {
    Some(match sub {
        "archive" => task_archive(args),
        "unarchive" => task_unarchive(args),
        "move" => task_move(args),
        "update" => task_update(args),
        "push" => task_push(args),
        "checkout" => task_checkout(args),
        "pr" => task_pr(args),
        "from-ticket" => task_from_ticket(args),
        _ => return None,
    })
}

/// `session` subcommands beyond create/kill/move/...; `None` when `sub` is none of them.
pub fn session_action(sub: &str, args: &[String]) -> Option<Result<()>> {
    Some(match sub {
        "adhoc" => session_adhoc(args),
        "merge" => session_merge(args),
        "update" => session_update(args),
        "resume" => session_resume(args),
        _ => return None,
    })
}

fn load_project(cfg: &Config, name: &str) -> Result<Project> {
    ops::find_project(cfg, name).cloned()
}

fn load_task(project: &Project, name: &str) -> Result<Task> {
    ops::find_task(project, name).cloned()
}

fn direction(word: &str) -> Result<bool> {
    match word {
        "up" => Ok(true),
        "down" => Ok(false),
        other => bail!("expected up or down, not '{other}'"),
    }
}

fn project_add(args: &[String]) -> Result<()> {
    let (positional, flags) = parse_args(args, &["name"], &[])?;
    let [path] = positional.as_slice() else {
        bail!("usage: project add <path> [--name <n>]");
    };
    let name = ops::add_project(path, flags.get("name").map(String::as_str))?;
    println!("added project '{name}'");
    Ok(())
}

fn project_delete(args: &[String]) -> Result<()> {
    let (positional, flags) = parse_args(args, &[], &["yes"])?;
    let [name] = positional.as_slice() else {
        bail!("usage: project delete <project> --yes");
    };
    if !flags.contains_key("yes") {
        bail!(
            "deleting a project kills its sessions and removes their worktrees and task \
             branches (the repository stays) — pass --yes to confirm"
        );
    }
    let project = load_project(&Config::load()?, name)?;
    ops::delete_project(&project)?;
    println!("deleted project '{name}'");
    Ok(())
}

fn project_move(args: &[String]) -> Result<()> {
    let [name, dir] = args else {
        bail!("usage: project move <project> up|down");
    };
    let up = direction(dir)?;
    let path = load_project(&Config::load()?, name)?.path;
    Config::modify(move |c| {
        c.move_project(&path, up);
    })?;
    Ok(())
}

fn project_branches(args: &[String]) -> Result<()> {
    let [name] = args else {
        bail!("usage: project branches <project>");
    };
    let project = load_project(&Config::load()?, name)?;
    for branch in session::list_branches(&project.path) {
        println!("{branch}");
    }
    Ok(())
}

fn checkout(path: &str, branch: &str) -> Result<()> {
    let out = std::process::Command::new("git")
        .args(["-C", path, "checkout", branch])
        .output()?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    println!("checked out {branch}");
    Ok(())
}

fn project_checkout(args: &[String]) -> Result<()> {
    let [name, branch] = args else {
        bail!("usage: project checkout <project> <branch>");
    };
    checkout(&load_project(&Config::load()?, name)?.path, branch)
}

fn project_fetch(args: &[String]) -> Result<()> {
    let [name] = args else {
        bail!("usage: project fetch <project>");
    };
    let project = load_project(&Config::load()?, name)?;
    println!("{}", session::fetch_pull_all(&project.path)?);
    Ok(())
}

fn project_set_run(args: &[String]) -> Result<()> {
    let (name, command) = match args {
        [name] => (name, String::new()),
        [name, command @ ..] => (name, command.join(" ")),
        _ => bail!("usage: project set-run <project> [<command>]   (omit to clear)"),
    };
    load_project(&Config::load()?, name)?;
    let name = name.clone();
    let command = command.trim().to_string();
    let cleared = command.is_empty();
    Config::modify(move |c| {
        if let Some(p) = c.projects.iter_mut().find(|p| p.name == name) {
            p.run_command = Some(command).filter(|c| !c.is_empty());
        }
    })?;
    println!(
        "{}",
        if cleared {
            "run command cleared"
        } else {
            "run command saved"
        }
    );
    Ok(())
}

fn task_archive(args: &[String]) -> Result<()> {
    let [project, task] = args else {
        bail!("usage: task archive <project> <task>");
    };
    let project = load_project(&Config::load()?, project)?;
    let stopped = ops::archive_task(&project, task)?;
    println!(
        "archived task '{task}' ({stopped} session{} suspended)",
        if stopped == 1 { "" } else { "s" }
    );
    Ok(())
}

fn task_unarchive(args: &[String]) -> Result<()> {
    let [project, task] = args else {
        bail!("usage: task unarchive <project> <task>");
    };
    let project = load_project(&Config::load()?, project)?;
    let (restored, failed) = ops::unarchive_task(&project, task)?;
    println!("unarchived task '{task}' ({restored} session(s) restored)");
    if !failed.is_empty() {
        bail!("could not restore {}", failed.join("; "));
    }
    Ok(())
}

fn task_move(args: &[String]) -> Result<()> {
    let [project, task, dir] = args else {
        bail!("usage: task move <project> <task> up|down");
    };
    let up = direction(dir)?;
    load_task(&load_project(&Config::load()?, project)?, task)?;
    let (project, task) = (project.clone(), task.clone());
    Config::modify(move |c| {
        if let Some(p) = c.projects.iter_mut().find(|p| p.name == project) {
            p.move_task(&task, up);
        }
    })?;
    Ok(())
}

fn task_update(args: &[String]) -> Result<()> {
    let [project, task] = args else {
        bail!("usage: task update <project> <task>   (rebase it onto its base branch)");
    };
    let project = load_project(&Config::load()?, project)?;
    let task = load_task(&project, task)?;
    println!(
        "{}",
        session::update_task_branch(&project.path, &task.branch, task.base_branch())?
    );
    Ok(())
}

fn task_push(args: &[String]) -> Result<()> {
    let [project, task] = args else {
        bail!("usage: task push <project> <task>");
    };
    let project = load_project(&Config::load()?, project)?;
    let task = load_task(&project, task)?;
    println!("{}", session::push_branch(&project.path, &task.branch)?);
    Ok(())
}

fn task_checkout(args: &[String]) -> Result<()> {
    let [project, task] = args else {
        bail!("usage: task checkout <project> <task>   (its branch, in the project folder)");
    };
    let project = load_project(&Config::load()?, project)?;
    let task = load_task(&project, task)?;
    checkout(&project.path, &task.branch)
}

fn task_pr(args: &[String]) -> Result<()> {
    let (positional, flags) = parse_args(args, &[], &["create"])?;
    let [project, task] = positional.as_slice() else {
        bail!("usage: task pr <project> <task> [--create]");
    };
    let project = load_project(&Config::load()?, project)?;
    let task = load_task(&project, task)?;
    if !flags.contains_key("create") && session::get_pr_info(&project.path, &task.branch).is_none()
    {
        bail!(
            "no PR for {} yet (pass --create to push it and open a draft)",
            task.branch
        );
    }
    println!("{}", ops::open_or_create_pr(&project, &task)?);
    Ok(())
}

/// A task named after a Linear ticket, on its Linear branch, linked to it,
/// with its main session prompted to start on it.
fn task_from_ticket(args: &[String]) -> Result<()> {
    let (positional, flags) = parse_args(args, &["agent"], &[])?;
    let [project, reference] = positional.as_slice() else {
        bail!("usage: task from-ticket <project> <ticket url|id> [--agent <id>]");
    };
    let cfg = Config::load()?;
    let project = load_project(&cfg, project)?;
    let agent = ops::resolve_agent(&cfg, flags.get("agent").map(String::as_str))?;
    let issue = ops::linear_issue(reference)?;
    let branch = Some(issue.branch_name)
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| session::to_branch_name(&issue.title));
    let prompt = ops::ticket_prompt(&issue.identifier);
    let (branch, cm_name) = ops::create_task(
        &cfg,
        &project,
        &issue.title,
        Some(&branch),
        None,
        None,
        Some(&prompt),
        Some(issue.url),
        agent,
    )?;
    println!("created task '{}' on branch {branch}", issue.title);
    println!("main session: {}", short_ref(&cm_name));
    Ok(())
}

fn group_rename(args: &[String]) -> Result<()> {
    let [project, group, new_name] = args else {
        bail!("usage: group rename <project> <group> <new name>");
    };
    let Some(new_name) = config::normalize_group(new_name) else {
        bail!("a group needs a name");
    };
    load_project(&Config::load()?, project)?;
    let (project, group) = (project.clone(), group.clone());
    let shown = new_name.clone();
    Config::modify(move |c| c.rename_group(&project, &group, Some(new_name)))?;
    println!("group renamed to '{shown}'");
    Ok(())
}

fn group_ungroup(args: &[String]) -> Result<()> {
    let [project, group] = args else {
        bail!("usage: group ungroup <project> <group>");
    };
    load_project(&Config::load()?, project)?;
    let (project, group) = (project.clone(), group.clone());
    Config::modify(move |c| c.rename_group(&project, &group, None))?;
    println!("group dissolved");
    Ok(())
}

fn group_move(args: &[String]) -> Result<()> {
    let (positional, flags) = parse_args(args, &[], &["archived"])?;
    let [project, group, dir] = positional.as_slice() else {
        bail!("usage: group move <project> <group> up|down [--archived]");
    };
    let up = direction(dir)?;
    let archived = flags.contains_key("archived");
    load_project(&Config::load()?, project)?;
    let (project, group) = (project.clone(), group.clone());
    Config::modify(move |c| {
        if let Some(p) = c.projects.iter_mut().find(|p| p.name == project) {
            p.move_group(&group, up, archived);
        }
    })?;
    Ok(())
}

fn session_adhoc(args: &[String]) -> Result<()> {
    let (positional, flags) = parse_args(args, &["agent"], &[])?;
    let [project, name] = positional.as_slice() else {
        bail!("usage: session adhoc <project> <name> [--agent <id>]");
    };
    let cfg = Config::load()?;
    let project = load_project(&cfg, project)?;
    let agent = ops::resolve_agent(&cfg, flags.get("agent").map(String::as_str))?;
    let cm_name = ops::create_adhoc_session(&cfg, &project, name, agent)?;
    println!("created session: {}", short_ref(&cm_name));
    Ok(())
}

fn session_merge(args: &[String]) -> Result<()> {
    let (positional, flags) = parse_args(args, &["message"], &[])?;
    let [reference] = positional.as_slice() else {
        bail!("usage: session merge <session> [--message <commit message>]");
    };
    let live = resolve_session(reference, &session::list_sessions().unwrap_or_default())?;
    println!(
        "{}",
        ops::merge_session(&live.name, flags.get("message").map(String::as_str))?
    );
    Ok(())
}

fn session_update(args: &[String]) -> Result<()> {
    let [reference] = args else {
        bail!("usage: session update <session>   (rebase it onto its task branch)");
    };
    let live = resolve_session(reference, &session::list_sessions().unwrap_or_default())?;
    println!("{}", ops::update_session(&live.name)?);
    Ok(())
}

/// Start a recorded session that isn't running (closed, or not restored).
fn session_resume(args: &[String]) -> Result<()> {
    let [reference] = args else {
        bail!("usage: session resume <project>/<task>/<session> | <cm__ name>");
    };
    let reference = reference.trim().trim_matches('/');
    let cm_name = if reference.starts_with("cm__") {
        reference.to_string()
    } else {
        let parts: Vec<&str> = reference.split('/').collect();
        let [project, task, name] = parts.as_slice() else {
            bail!("'{reference}' is not <project>/<task>/<session>");
        };
        session::build_session_name(project, task, name)
    };
    ops::resume_session(&Config::load()?, &cm_name)?;
    println!("resumed {}", short_ref(&cm_name));
    Ok(())
}

fn short_ref(cm_name: &str) -> String {
    LiveSession::from_name(cm_name)
        .map(|s| session_ref(&s))
        .unwrap_or_else(|| cm_name.to_string())
}

/// A project, task or session, as `run` and `review` address them.
enum Item {
    Project(Project),
    Task(Project, Task),
    Session(Project, LiveSession),
}

/// `<project>`, `<project>/<task>`, or a session ref with its session part
/// (`<project>/<task>/<session>`, a `cm__` name).
fn resolve_item(cfg: &Config, reference: &str) -> Result<Item> {
    let reference = reference.trim().trim_matches('/');
    let parts: Vec<&str> = reference.split('/').collect();
    match parts.as_slice() {
        [project] if !reference.starts_with("cm__") => {
            Ok(Item::Project(load_project(cfg, project)?))
        }
        [project, task] => {
            let project = load_project(cfg, project)?;
            let task = load_task(&project, task)?;
            Ok(Item::Task(project, task))
        }
        _ => {
            let live = resolve_session(reference, &session::list_sessions().unwrap_or_default())?;
            let project = cfg
                .projects
                .iter()
                .find(|p| session::sanitize(&p.name) == live.project_name)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("no project for {reference}"))?;
            Ok(Item::Session(project, live))
        }
    }
}

/// The idea queue of a session's task (see `ideas.rs`): this session's, or
/// `--for <session>`'s.
pub fn cmd_ideas(args: &[String]) -> Result<()> {
    let usage = "usage: ideas list [--json] | add <idea>... | start|done|remove|sent <id> | \
                 edit <id> <text>   [--for <session>]";
    let Some(sub) = args.first().map(String::as_str) else {
        bail!("{usage}");
    };
    let (positional, flags) = parse_args(&args[1..], &["for"], &["json"])?;
    let cm_name = match flags.get("for") {
        Some(reference) => resolve_recorded_session(reference)?,
        None => current_session_name().ok_or_else(|| {
            anyhow::anyhow!("not inside a showrunner session; pass --for <session>")
        })?,
    };
    let record = config::load_sessions()
        .remove(&cm_name)
        .ok_or_else(|| anyhow::anyhow!("no session record for {cm_name}"))?;
    let path = ideas::queue_path(&record);
    let mut queue = ideas::load(&path);
    let one_id = || match positional.as_slice() {
        [id] => Ok(id.clone()),
        _ => Err(anyhow::anyhow!("{usage}")),
    };
    match sub {
        "list" => {
            if flags.contains_key("json") {
                println!("{}", serde_json::to_string(&queue)?);
            } else {
                println!("{}", ideas::describe(&queue));
            }
            return Ok(());
        }
        "add" => {
            let added: Vec<ideas::Idea> = positional
                .iter()
                .filter(|text| !text.trim().is_empty())
                .map(|text| ideas::new_idea(text))
                .collect();
            if added.is_empty() {
                bail!("give at least one idea");
            }
            let shown: Vec<String> = added
                .iter()
                .map(|i| format!("[id {}] {}", i.id, i.text))
                .collect();
            queue.extend(added);
            ideas::save(&path, &queue)?;
            println!("Added {}. {} in the queue.", shown.join("; "), queue.len());
        }
        "start" => {
            ideas::change(&mut queue, &one_id()?, Change::Start)?;
            ideas::save(&path, &queue)?;
            println!("Marked as started.");
        }
        "done" | "remove" => {
            ideas::change(&mut queue, &one_id()?, Change::Remove)?;
            ideas::save(&path, &queue)?;
            println!("Done; {} left in the queue.", queue.len());
        }
        "sent" => {
            ideas::change(&mut queue, &one_id()?, Change::Sent)?;
            ideas::save(&path, &queue)?;
        }
        "edit" => {
            let [id, text @ ..] = positional.as_slice() else {
                bail!("{usage}");
            };
            let text = text.join(" ");
            if text.trim().is_empty() {
                bail!("an idea needs some text");
            }
            ideas::change(&mut queue, id, Change::Edit(text))?;
            ideas::save(&path, &queue)?;
        }
        _ => bail!("{usage}"),
    }
    Ok(())
}

/// Install the Herdr mods and layout (see `herdr.rs`).
pub fn cmd_herdr(args: &[String]) -> Result<()> {
    let rest = args.get(1..).unwrap_or_default();
    let (positional, flags) = parse_args(rest, &["home", "bin"], &["no-keys"])?;
    if args.first().map(String::as_str) != Some("install") || !positional.is_empty() {
        bail!("usage: herdr install [--home <herdr home>] [--bin <showrunner>] [--no-keys]");
    }
    let home = flags
        .get("home")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(crate::herdr::default_home);
    // A build under another name (showrunner-hc) is what the mods should run.
    let exe = std::env::current_exe()?;
    let bin = match flags.get("bin") {
        Some(bin) => Some(bin.clone()),
        None => (exe.file_name().is_some_and(|n| n != "showrunner"))
            .then(|| exe.to_string_lossy().to_string()),
    };
    let installed = crate::herdr::install(&home, bin.as_deref(), !flags.contains_key("no-keys"))?;
    for note in installed.notes {
        println!("{note}");
    }
    println!(
        "Switch to it with Cmd-Shift-L, from Settings, or: herdr-app do layout.switch --name showrunner"
    );
    Ok(())
}

/// Start (or restart) an item's run command in its own terminal, or end it.
pub fn cmd_run(args: &[String]) -> Result<()> {
    let (positional, flags) = parse_args(args, &["command"], &["kill"])?;
    let [reference] = positional.as_slice() else {
        bail!("usage: run <project | project/task | session> [--command <cmd>] [--kill]");
    };
    let cfg = Config::load()?;
    let target = match resolve_item(&cfg, reference)? {
        Item::Project(p) => ops::run_target_project(&p),
        Item::Task(p, t) => ops::run_target_task(&p, &t),
        Item::Session(p, s) => ops::run_target_session(&p, &s),
    };
    let name = session::run_session_name(&target.label);
    if flags.contains_key("kill") {
        session::kill_session_only(&name)?;
        println!("stopped {name}");
        return Ok(());
    }
    let given = flags
        .get("command")
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    let command = match given {
        Some(command) => {
            let (project, saved) = (target.project.clone(), command.clone());
            Config::modify(move |c| {
                c.set_project_run_command(&project, saved);
            })?;
            command
        }
        None => match cfg.project_run_command(&target.project) {
            Some(command) => command.to_string(),
            None => bail!(
                "project '{}' has no run command yet (pass --command <cmd> to set it)",
                target.project
            ),
        },
    };
    session::run_command_session(&target.label, &target.cwd, &command, &target.space)?;
    println!("running {name}: {command}");
    Ok(())
}

/// Review a task's branch or a session's uncommitted changes in this terminal
/// (the configured tool), then send the comments to the agent.
pub fn cmd_review(args: &[String]) -> Result<()> {
    let (positional, flags) = parse_args(args, &["tool"], &[])?;
    let [reference] = positional.as_slice() else {
        bail!("usage: review <project/task | session> [--tool hunk|difit]");
    };
    let cfg = Config::load()?;
    let target = match resolve_item(&cfg, reference)? {
        Item::Task(p, t) => review::for_task(
            &p.name,
            &p.path,
            &t,
            &session::list_sessions().unwrap_or_default(),
        ),
        Item::Session(p, s) => review::for_session(&p.path, &s),
        Item::Project(_) => bail!("review a task or a session, not a project"),
    };
    let difit = match flags.get("tool").map(String::as_str) {
        Some("difit") => true,
        Some("hunk") => false,
        Some(other) => bail!("unknown review tool '{other}' (hunk or difit)"),
        None => matches!(cfg.review_tool, config::ReviewTool::Difit),
    };
    println!("Reviewing {}…", target.description);
    let comments = if difit {
        review::run_difit(&target.cwd, &target.difit_args)?
    } else {
        review::run_hunk(&target.cwd, &target.hunk_args)?
    };
    let Some(comments) = comments else {
        println!("Review closed with no comments.");
        return Ok(());
    };
    let Some((cm_name, display)) = pick_session(&target.candidates)? else {
        println!("No session to send the comments to:\n\n{comments}");
        return Ok(());
    };
    session::send_text(&cm_name, &review::prompt(&comments), true)?;
    println!("Sent the review comments to {display}.");
    Ok(())
}

/// The session the comments go to: the only one, else asked on this terminal.
fn pick_session(candidates: &[(String, String)]) -> Result<Option<(String, String)>> {
    match candidates {
        [] => Ok(None),
        [only] => Ok(Some(only.clone())),
        _ => {
            println!("Send the comments to which session?");
            for (i, (_, display)) in candidates.iter().enumerate() {
                println!("  {}) {display}", i + 1);
            }
            loop {
                print!("> ");
                std::io::stdout().flush()?;
                let mut line = String::new();
                if std::io::stdin().lock().read_line(&mut line)? == 0 {
                    return Ok(None);
                }
                match line.trim().parse::<usize>() {
                    Ok(n) if (1..=candidates.len()).contains(&n) => {
                        return Ok(Some(candidates[n - 1].clone()));
                    }
                    _ => println!("1–{}, please", candidates.len()),
                }
            }
        }
    }
}
