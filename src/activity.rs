//! What a Claude session is doing, rebuilt from its conversation file the way
//! the activity Claude mod keeps it live: the main loop and its subagents
//! (nested under whoever started them), each with its tool calls, task list and
//! shell commands, plus how much context the conversation fills.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

/// How much of a conversation file is read, from its end: the recent work.
const TAIL_BYTES: u64 = 4 << 20;
/// How much of a background shell's output file is read for its last lines.
const OUTPUT_TAIL_BYTES: u64 = 16 << 10;
const TAIL_LINES: usize = 4;
const KEEP_FINISHED_SHELLS: usize = 50;
const KEEP_SUBAGENTS: usize = 30;
const MAIN: &str = "main";

#[derive(Serialize, Default)]
pub struct Board {
    loops: Vec<Loop>,
    context: Option<Context>,
}

#[derive(Serialize)]
struct Context {
    tokens: u64,
    window: u64,
}

/// A model loop: the main session or one of its subagents.
#[derive(Serialize, Default)]
struct Loop {
    id: String,
    label: String,
    #[serde(rename = "type")]
    kind: Option<String>,
    /// running, idle, completed, failed or killed.
    status: &'static str,
    parent: Option<String>,
    started_at: Option<String>,
    ended_at: Option<String>,
    turn_started_at: Option<String>,
    tools: usize,
    /// The tool call under way, in a few words, since `current_at`.
    current: Option<String>,
    current_at: Option<String>,
    current_command: Option<String>,
    tasks: Vec<Task>,
    shells: Vec<Shell>,
    #[serde(skip)]
    pending: Vec<Call>,
    #[serde(skip)]
    call_ids: Vec<String>,
    #[serde(skip)]
    turn_ended_at: Option<String>,
}

struct Call {
    id: String,
    tool: String,
    input: Value,
    at: String,
}

#[derive(Serialize, Clone)]
struct Task {
    id: String,
    title: String,
    status: String,
    started_at: Option<String>,
    ended_at: Option<String>,
}

#[derive(Serialize)]
struct Shell {
    id: String,
    title: Option<String>,
    command: String,
    /// running, completed, failed or killed.
    status: &'static str,
    started_at: String,
    ended_at: Option<String>,
    #[serde(skip)]
    output_path: Option<String>,
    /// A foreground command's whole output (a background one's is its file).
    #[serde(skip)]
    output: Option<String>,
    tail: Vec<String>,
}

/// A background task's notice that it ended: its id and how.
struct Notice {
    id: String,
    status: &'static str,
    at: String,
}

/// The board for the conversation in `transcript` (`<id>.jsonl`); its
/// subagents' files are in `<id>/subagents/`.
pub fn board(transcript: &Path) -> Board {
    let mut notices = Vec::new();
    let mut main = Loop {
        id: MAIN.into(),
        label: "Main session".into(),
        ..Loop::default()
    };
    let mut context = None;
    for line in tail_lines(transcript, TAIL_BYTES) {
        main.read(&line, &mut notices);
        if let Some(c) = usage(&line) {
            context = Some(c);
        }
    }
    let running = main
        .turn_started_at
        .as_ref()
        .is_some_and(|start| main.turn_ended_at.as_ref().is_none_or(|end| end < start));
    main.status = if running { "running" } else { "idle" };
    main.started_at = main.turn_started_at.clone();
    let since = main.turn_started_at.clone();
    main.settle(running, since.as_deref());

    let mut loops = vec![main];
    loops.extend(subagents(transcript, &mut notices));
    for notice in &notices {
        for lp in &mut loops {
            if lp.id == notice.id && lp.status == "running" {
                lp.status = notice.status;
                lp.ended_at.get_or_insert_with(|| notice.at.clone());
            }
            for shell in &mut lp.shells {
                if shell.id == notice.id && shell.status == "running" {
                    shell.status = notice.status;
                    shell.ended_at = Some(notice.at.clone());
                }
            }
        }
    }
    // A subagent is nested under the loop whose call started it.
    let owners: HashMap<String, String> = loops
        .iter()
        .flat_map(|lp| lp.call_ids.iter().map(|c| (c.clone(), lp.id.clone())))
        .collect();
    for lp in loops.iter_mut().skip(1) {
        let started_by = lp.parent.take().unwrap_or_default();
        lp.parent = Some(
            owners
                .get(&started_by)
                .cloned()
                .unwrap_or_else(|| MAIN.into()),
        );
    }
    for lp in &mut loops {
        for shell in &mut lp.shells {
            if let Some(path) = &shell.output_path
                && (shell.status == "running" || shell.tail.is_empty())
                && let Some(text) = tail_text(Path::new(path), OUTPUT_TAIL_BYTES)
            {
                shell.tail = last_lines(&text);
            }
        }
    }
    Board { loops, context }
}

/// A shell's whole output, without colour codes: a background one's file, a
/// foreground one's from the conversation.
pub fn shell_output(transcript: &Path, shell_id: &str) -> Option<String> {
    let board = board(transcript);
    let shell = board
        .loops
        .iter()
        .flat_map(|l| &l.shells)
        .find(|s| s.id == shell_id)?;
    match &shell.output_path {
        Some(path) => fs::read_to_string(path).ok().map(|text| strip_ansi(&text)),
        None => shell.output.clone(),
    }
}

impl Loop {
    fn read(&mut self, line: &Value, notices: &mut Vec<Notice>) {
        let at = line["timestamp"].as_str().unwrap_or_default().to_string();
        match line["type"].as_str() {
            Some("assistant") => {
                for block in blocks(line) {
                    if block["type"] == "tool_use" {
                        let id = block["id"].as_str().unwrap_or_default().to_string();
                        self.tools += 1;
                        self.call_ids.push(id.clone());
                        self.pending.push(Call {
                            id,
                            tool: block["name"].as_str().unwrap_or_default().to_string(),
                            input: block["input"].clone(),
                            at: at.clone(),
                        });
                    }
                }
            }
            Some("user") => {
                let results: Vec<&Value> = blocks(line)
                    .iter()
                    .filter(|b| b["type"] == "tool_result")
                    .collect();
                if results.is_empty() {
                    let text = text_of(&line["message"]["content"]);
                    notices.extend(notices_in(&text, &at));
                    if line["isMeta"] != true && is_prompt(&text) {
                        self.turn_started_at = Some(at);
                    }
                    return;
                }
                for block in results {
                    let id = block["tool_use_id"].as_str().unwrap_or_default();
                    if let Some(i) = self.pending.iter().position(|c| c.id == id) {
                        let call = self.pending.remove(i);
                        self.finish(&call, &line["toolUseResult"], block, &at);
                    }
                }
            }
            Some("queue-operation") => {
                notices.extend(notices_in(
                    line["content"].as_str().unwrap_or_default(),
                    &at,
                ));
            }
            // A subagent gets its background tasks' notices as queued commands.
            Some("attachment") if line["attachment"]["type"] == "queued_command" => {
                notices.extend(notices_in(&text_of(&line["attachment"]["prompt"]), &at));
            }
            Some("system") if line["subtype"] == "turn_duration" => self.turn_ended_at = Some(at),
            _ => {}
        }
    }

    /// What a call's result changes: the task list and the shells.
    fn finish(&mut self, call: &Call, result: &Value, block: &Value, at: &str) {
        let input = &call.input;
        match call.tool.as_str() {
            "TodoWrite" => self.tasks = from_todos(&self.tasks, &input["todos"], at),
            "TaskCreate" => {
                if let Some(id) = str_of(&result["task"]["id"]) {
                    let title = str_of(&result["task"]["subject"])
                        .or(str_of(&input["subject"]))
                        .unwrap_or("…");
                    self.tasks.push(Task {
                        id: id.into(),
                        title: title.into(),
                        status: "pending".into(),
                        started_at: None,
                        ended_at: None,
                    });
                }
            }
            "TaskUpdate" => {
                let id = str_of(&input["taskId"]);
                let status = str_of(&input["status"]);
                if status == Some("deleted") {
                    self.tasks.retain(|t| Some(t.id.as_str()) != id);
                    return;
                }
                for task in self.tasks.iter_mut().filter(|t| Some(t.id.as_str()) == id) {
                    let status = status.unwrap_or(&task.status).to_string();
                    let subject = str_of(&input["subject"]);
                    task.title = if status == "in_progress" {
                        str_of(&input["activeForm"])
                            .or(subject)
                            .unwrap_or(&task.title)
                    } else {
                        subject.unwrap_or(&task.title)
                    }
                    .to_string();
                    *task = timed(
                        Task {
                            status,
                            ..task.clone()
                        },
                        Some(&*task),
                        at,
                    );
                }
            }
            "Bash" => {
                let command = str_of(&input["command"]).unwrap_or("shell");
                let shell = match str_of(&result["backgroundTaskId"]) {
                    Some(id) => Shell {
                        id: id.into(),
                        title: str_of(&input["description"]).map(str::to_string),
                        command: command.into(),
                        status: "running",
                        started_at: call.at.clone(),
                        ended_at: None,
                        output_path: str_of(&result["backgroundOutputPath"])
                            .map(str::to_string)
                            .or_else(|| output_path_in(&text_of(&block["content"]))),
                        output: None,
                        tail: Vec::new(),
                    },
                    None => {
                        let output = [str_of(&result["stdout"]), str_of(&result["stderr"])]
                            .into_iter()
                            .flatten()
                            .collect::<Vec<_>>()
                            .join("\n");
                        let output = if output.is_empty() {
                            text_of(&block["content"])
                        } else {
                            output
                        };
                        let failed = block["is_error"] == true || result["interrupted"] == true;
                        Shell {
                            id: format!("fg-{}", call.id),
                            title: str_of(&input["description"]).map(str::to_string),
                            command: command.into(),
                            status: if failed { "failed" } else { "completed" },
                            started_at: call.at.clone(),
                            ended_at: Some(at.into()),
                            output_path: None,
                            tail: last_lines(&output),
                            output: Some(strip_ansi(&output)),
                        }
                    }
                };
                self.add_shell(shell);
            }
            "TaskStop" | "KillShell" => {
                let id = str_of(&input["task_id"]).or(str_of(&input["shell_id"]));
                for shell in self.shells.iter_mut() {
                    if Some(shell.id.as_str()) == id && shell.status == "running" {
                        shell.status = "killed";
                        shell.ended_at = Some(at.into());
                    }
                }
            }
            _ => {}
        }
    }

    /// Appends a shell, dropping the oldest finished ones past the cap.
    fn add_shell(&mut self, shell: Shell) {
        self.shells.retain(|s| s.id != shell.id);
        self.shells.push(shell);
        let finished = self.shells.iter().filter(|s| s.status != "running").count();
        let mut extra = finished.saturating_sub(KEEP_FINISHED_SHELLS);
        self.shells.retain(|s| {
            let drop = extra > 0 && s.status != "running";
            extra -= usize::from(drop);
            !drop
        });
    }

    /// The call still under way (the newest without a result) while the loop
    /// runs; calls left without one by an earlier turn don't count.
    fn settle(&mut self, running: bool, since: Option<&str>) {
        let current = self
            .pending
            .iter()
            .rev()
            .find(|c| running && since.is_none_or(|s| c.at.as_str() >= s));
        if let Some(call) = current {
            self.current = Some(describe_call(&call.tool, &call.input));
            self.current_at = Some(call.at.clone());
            self.current_command = (call.tool == "Bash")
                .then(|| str_of(&call.input["command"]).map(|c| one_line(c, 400)))
                .flatten();
        }
    }
}

/// The subagents started in the conversation, newest first, from their
/// `agent-<id>.meta.json` and `agent-<id>.jsonl` files. `parent` holds the
/// tool call that started each until `board` resolves its loop.
fn subagents(transcript: &Path, notices: &mut Vec<Notice>) -> Vec<Loop> {
    let dir = transcript.with_extension("").join("subagents");
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut metas: Vec<(std::time::SystemTime, String, Value)> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let id = name
                .strip_prefix("agent-")?
                .strip_suffix(".meta.json")?
                .to_string();
            let meta = serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok()?;
            let modified = fs::metadata(dir.join(format!("agent-{id}.jsonl")))
                .and_then(|m| m.modified())
                .ok()?;
            Some((modified, id, meta))
        })
        .collect();
    metas.sort_by(|a, b| b.0.cmp(&a.0));
    metas
        .into_iter()
        .take(KEEP_SUBAGENTS)
        .map(|(_, id, meta)| {
            let mut lp = Loop {
                label: one_line(
                    str_of(&meta["description"])
                        .or(str_of(&meta["agentType"]))
                        .unwrap_or("Subagent"),
                    60,
                ),
                kind: str_of(&meta["agentType"]).map(str::to_string),
                parent: str_of(&meta["toolUseId"]).map(str::to_string),
                id,
                ..Loop::default()
            };
            let mut first = None;
            let mut last = None;
            // How the conversation's last message ended it, if it did: on
            // the final answer or on an interruption (until resumed).
            let mut ending = None;
            for line in tail_lines(&dir.join(format!("agent-{}.jsonl", lp.id)), TAIL_BYTES) {
                lp.read(&line, notices);
                if matches!(line["type"].as_str(), Some("user" | "assistant")) {
                    ending = if line["message"]["stop_reason"] == "end_turn" {
                        Some("completed")
                    } else if is_interrupt(&line) {
                        Some("killed")
                    } else {
                        None
                    };
                }
                if let Some(at) = str_of(&line["timestamp"]) {
                    first.get_or_insert_with(|| at.to_string());
                    last = Some(at.to_string());
                }
            }
            // `finished` in the meta is missing for a stopped subagent, and
            // for any written by Claude Code before it kept one.
            let finished = meta["finished"] == true || ending == Some("completed");
            let stopped = !finished && (meta["stoppedByUser"] == true || ending == Some("killed"));
            lp.status = if finished {
                "completed"
            } else if stopped {
                "killed"
            } else {
                "running"
            };
            lp.started_at = first;
            if finished || stopped {
                lp.ended_at = last;
            }
            lp.settle(lp.status == "running", None);
            lp
        })
        .collect()
}

/// The conversation's context use, from an assistant message's usage.
fn usage(line: &Value) -> Option<Context> {
    let message = &line["message"];
    if line["type"] != "assistant" || line["isSidechain"] == true {
        return None;
    }
    let model = message["model"].as_str()?;
    let u = &message["usage"];
    let tokens = [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .iter()
    .map(|k| u[k].as_u64().unwrap_or(0))
    .sum::<u64>();
    if model.starts_with('<') || tokens == 0 {
        return None;
    }
    Some(Context {
        tokens,
        window: context_window(model),
    })
}

/// The Claude 5 models hold a million tokens, the ones before 200k.
fn context_window(model: &str) -> u64 {
    let generation = model
        .split('-')
        .find_map(|part| part.parse::<u32>().ok())
        .unwrap_or(0);
    if generation >= 5 { 1_000_000 } else { 200_000 }
}

/// A person's prompt starts a turn; notices, commands and reminders don't.
fn is_prompt(text: &str) -> bool {
    let text = text.trim_start();
    !text.is_empty()
        && ![
            "<task-notification>",
            "<command-",
            "<local-command",
            "<system-reminder>",
            "<bash-",
        ]
        .iter()
        .any(|p| text.starts_with(p))
}

/// Claude's note that the person stopped the loop mid-turn.
fn is_interrupt(line: &Value) -> bool {
    line["type"] == "user"
        && text_of(&line["message"]["content"])
            .trim_start()
            .starts_with("[Request interrupted by user")
}

fn notices_in(text: &str, at: &str) -> Vec<Notice> {
    text.split("<task-notification>")
        .skip(1)
        .filter_map(|notice| {
            let id = between(notice, "<task-id>", "</task-id>")?
                .trim()
                .to_string();
            let status = match between(notice, "<status>", "</status>")?.trim() {
                "completed" => "completed",
                "killed" => "killed",
                _ => "failed",
            };
            Some(Notice {
                id,
                status,
                at: at.into(),
            })
        })
        .collect()
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(&text[start..end])
}

/// A task list as TodoWrite writes it: whole, its items known by their text.
fn from_todos(old: &[Task], todos: &Value, at: &str) -> Vec<Task> {
    let Some(todos) = todos.as_array() else {
        return old.to_vec();
    };
    todos
        .iter()
        .map(|todo| {
            let content = str_of(&todo["content"]).unwrap_or("…");
            let status = str_of(&todo["status"]).unwrap_or("pending");
            let title = if status == "in_progress" {
                str_of(&todo["activeForm"]).unwrap_or(content)
            } else {
                content
            };
            let task = Task {
                id: content.into(),
                title: title.into(),
                status: status.into(),
                started_at: None,
                ended_at: None,
            };
            let before = old.iter().find(|t| t.id == content);
            timed(task, before, at)
        })
        .collect()
}

/// Carries a task's times over, starting or stopping its clock as its status changes.
fn timed(task: Task, before: Option<&Task>, at: &str) -> Task {
    let pending = task.status == "pending";
    let started = before
        .and_then(|b| b.started_at.clone())
        .or_else(|| (!pending).then(|| at.to_string()));
    let ended = (task.status == "completed").then(|| {
        before
            .and_then(|b| b.ended_at.clone())
            .unwrap_or_else(|| at.to_string())
    });
    Task {
        started_at: if pending { None } else { started },
        ended_at: ended,
        ..task
    }
}

/// What a tool call is doing, in a few words.
fn describe_call(tool: &str, input: &Value) -> String {
    let what = [
        "description",
        "command",
        "file_path",
        "pattern",
        "url",
        "query",
        "subject",
        "prompt",
    ]
    .iter()
    .find_map(|k| str_of(&input[k]));
    let name = match tool.strip_prefix("mcp__") {
        Some(rest) => rest.replace("__", " "),
        None => tool.to_string(),
    };
    match what {
        Some(what) => format!("{name}: {}", one_line(what, 60)),
        None => name,
    }
}

fn one_line(text: &str, max: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() > max {
        format!("{}…", line.chars().take(max - 1).collect::<String>())
    } else {
        line
    }
}

/// The output file a background command's result names; the sentence's full stop isn't part of it.
fn output_path_in(text: &str) -> Option<String> {
    let rest = text.split("Output is being written to: ").nth(1)?;
    let path = rest.split_whitespace().next()?;
    Some(path.strip_suffix('.').unwrap_or(path).to_string())
}

/// The last non-empty lines of some output, without colour codes.
fn last_lines(text: &str) -> Vec<String> {
    let lines: Vec<String> = strip_ansi(text)
        .split(['\n', '\r'])
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    lines[lines.len().saturating_sub(TAIL_LINES)..].to_vec()
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.next() == Some('[') {
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        }
    }
    out
}

fn blocks(line: &Value) -> &[Value] {
    line["message"]["content"]
        .as_array()
        .map_or(&[], Vec::as_slice)
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn str_of(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| !s.is_empty())
}

/// The file's last `max` bytes as text, from its first whole line.
fn tail_text(path: &Path, max: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(max);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Some(if start > 0 {
        text.split_once('\n')
            .map(|(_, rest)| rest.to_string())
            .unwrap_or_default()
    } else {
        text
    })
}

fn tail_lines(path: &Path, max: u64) -> Vec<Value> {
    tail_text(path, max)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(dir: &Path, name: &str, lines: &[Value]) -> std::path::PathBuf {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
        fs::write(&path, text).unwrap();
        path
    }

    fn assistant(at: &str, blocks: Value) -> Value {
        json!({"type": "assistant", "timestamp": at, "message": {"model": "claude-opus-5-5", "content": blocks,
            "usage": {"input_tokens": 10, "cache_read_input_tokens": 49_990, "cache_creation_input_tokens": 0}}})
    }

    fn result(at: &str, id: &str, content: &str, extra: Value) -> Value {
        json!({"type": "user", "timestamp": at, "toolUseResult": extra,
            "message": {"content": [{"type": "tool_result", "tool_use_id": id, "content": content}]}})
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sr-activity-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rebuilds_shells_tasks_current_call_and_context() {
        let dir = scratch("main");
        let output = dir.join("bg.output");
        fs::write(&output, "building\n\u{1b}[32mok\u{1b}[0m\n").unwrap();
        let transcript = write(
            &dir,
            "c.jsonl",
            &[
                json!({"type": "user", "timestamp": "2026-11-10T10:00:00Z", "message": {"content": "Fix it"}}),
                assistant(
                    "2026-11-10T10:00:01Z",
                    json!([
                        {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "cargo test", "description": "Run tests"}},
                    ]),
                ),
                result(
                    "2026-11-10T10:00:05Z",
                    "t1",
                    "ok",
                    json!({"stdout": "a\nb\ntest result: ok", "stderr": ""}),
                ),
                assistant(
                    "2026-11-10T10:00:06Z",
                    json!([
                        {"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": "npm run dev", "run_in_background": true}},
                    ]),
                ),
                result(
                    "2026-11-10T10:00:07Z",
                    "t2",
                    &format!(
                        "Command running in background with ID: bg1. Output is being written to: {}.",
                        output.display()
                    ),
                    json!({"backgroundTaskId": "bg1"}),
                ),
                assistant(
                    "2026-11-10T10:00:08Z",
                    json!([
                        {"type": "tool_use", "id": "t3", "name": "TodoWrite", "input": {"todos": [
                            {"content": "Write code", "status": "in_progress", "activeForm": "Writing code"},
                            {"content": "Test", "status": "pending"}]}},
                    ]),
                ),
                result("2026-11-10T10:00:09Z", "t3", "ok", json!({})),
                assistant(
                    "2026-11-10T10:00:10Z",
                    json!([
                        {"type": "tool_use", "id": "t4", "name": "Read", "input": {"file_path": "/src/main.rs"}},
                    ]),
                ),
            ],
        );

        let board = board(&transcript);
        let main = &board.loops[0];
        assert_eq!(main.status, "running");
        assert_eq!(main.tools, 4);
        assert_eq!(main.current.as_deref(), Some("Read: /src/main.rs"));
        assert_eq!(main.shells[0].status, "completed");
        assert_eq!(main.shells[0].tail, ["a", "b", "test result: ok"]);
        assert_eq!(main.shells[1].id, "bg1");
        assert_eq!(main.shells[1].status, "running");
        assert_eq!(main.shells[1].tail, ["building", "ok"]);
        assert_eq!(main.tasks[0].title, "Writing code");
        assert_eq!(
            main.tasks[0].started_at.as_deref(),
            Some("2026-11-10T10:00:09Z")
        );
        assert_eq!(
            board.context.as_ref().map(|c| (c.tokens, c.window)),
            Some((50_000, 1_000_000))
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_notice_ends_a_shell_and_a_turn_end_clears_the_current_call() {
        let dir = scratch("notice");
        let transcript = write(
            &dir,
            "c.jsonl",
            &[
                json!({"type": "user", "timestamp": "2026-11-10T10:00:00Z", "message": {"content": "Go"}}),
                assistant(
                    "2026-11-10T10:00:01Z",
                    json!([
                        {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "sleep 9", "run_in_background": true}},
                    ]),
                ),
                result(
                    "2026-11-10T10:00:02Z",
                    "t1",
                    "started",
                    json!({"backgroundTaskId": "bg1"}),
                ),
                assistant(
                    "2026-11-10T10:00:03Z",
                    json!([{"type": "tool_use", "id": "t2", "name": "Read", "input": {}}]),
                ),
                json!({"type": "system", "subtype": "turn_duration", "timestamp": "2026-11-10T10:00:04Z"}),
                json!({"type": "user", "timestamp": "2026-11-10T10:00:12Z", "message": {"content":
                "<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n</task-notification>"}}),
            ],
        );

        let board = board(&transcript);
        let main = &board.loops[0];
        assert_eq!(main.status, "idle");
        assert_eq!(main.current, None);
        assert_eq!(main.shells[0].status, "completed");
        assert_eq!(
            main.shells[0].ended_at.as_deref(),
            Some("2026-11-10T10:00:12Z")
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn subagents_nest_under_the_loop_that_started_them() {
        let dir = scratch("agents");
        let transcript = write(
            &dir,
            "c.jsonl",
            &[
                json!({"type": "user", "timestamp": "2026-11-10T10:00:00Z", "message": {"content": "Look around"}}),
                assistant(
                    "2026-11-10T10:00:01Z",
                    json!([
                        {"type": "tool_use", "id": "a1", "name": "Agent", "input": {"description": "Explore the code"}},
                    ]),
                ),
            ],
        );
        let subagents = dir.join("c/subagents");
        fs::create_dir_all(&subagents).unwrap();
        fs::write(subagents.join("agent-x1.meta.json"),
            json!({"description": "Explore the code", "agentType": "Explore", "toolUseId": "a1", "finished": false}).to_string()).unwrap();
        write(
            &subagents,
            "agent-x1.jsonl",
            &[
                json!({"type": "user", "timestamp": "2026-11-10T10:00:02Z", "message": {"content": "Explore"}}),
                assistant(
                    "2026-11-10T10:00:03Z",
                    json!([
                        {"type": "tool_use", "id": "s1", "name": "Agent", "input": {"description": "Deeper"}},
                        {"type": "tool_use", "id": "s2", "name": "Grep", "input": {"pattern": "fn main"}},
                    ]),
                ),
            ],
        );
        fs::write(subagents.join("agent-x2.meta.json"),
            json!({"description": "Deeper", "agentType": "Explore", "toolUseId": "s1", "finished": true}).to_string()).unwrap();
        write(
            &subagents,
            "agent-x2.jsonl",
            &[
                json!({"type": "user", "timestamp": "2026-11-10T10:00:04Z", "message": {"content": "Dig"}}),
            ],
        );

        let board = board(&transcript);
        let find = |id: &str| board.loops.iter().find(|l| l.id == id).unwrap();
        assert_eq!(find("x1").parent.as_deref(), Some(MAIN));
        assert_eq!(find("x1").status, "running");
        assert_eq!(find("x1").current.as_deref(), Some("Grep: fn main"));
        assert_eq!(find("x2").parent.as_deref(), Some("x1"));
        assert_eq!(find("x2").status, "completed");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_queued_notice_ends_a_subagents_shell() {
        let dir = scratch("queued");
        let transcript = write(
            &dir,
            "c.jsonl",
            &[
                json!({"type": "user", "timestamp": "2026-11-10T10:00:00Z", "message": {"content": "Check it"}}),
                assistant(
                    "2026-11-10T10:00:01Z",
                    json!([
                        {"type": "tool_use", "id": "a1", "name": "Agent", "input": {"description": "Run the checks"}},
                    ]),
                ),
            ],
        );
        let subagents = dir.join("c/subagents");
        fs::create_dir_all(&subagents).unwrap();
        fs::write(
            subagents.join("agent-x1.meta.json"),
            json!({"description": "Run the checks", "toolUseId": "a1", "finished": true})
                .to_string(),
        )
        .unwrap();
        write(
            &subagents,
            "agent-x1.jsonl",
            &[
                json!({"type": "user", "timestamp": "2026-11-10T10:00:02Z", "message": {"content": "Run them"}}),
                assistant(
                    "2026-11-10T10:00:03Z",
                    json!([
                        {"type": "tool_use", "id": "s1", "name": "Bash", "input": {"command": "cargo test", "run_in_background": true}},
                    ]),
                ),
                result(
                    "2026-11-10T10:00:04Z",
                    "s1",
                    "started",
                    json!({"backgroundTaskId": "bg1"}),
                ),
                json!({"type": "attachment", "timestamp": "2026-11-10T10:00:30Z", "isSidechain": true, "attachment": {
                    "type": "queued_command",
                    "prompt": "<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n</task-notification>"}}),
            ],
        );

        fs::write(
            subagents.join("agent-x2.meta.json"),
            json!({"description": "Play it", "toolUseId": "a2", "requestShape": "background"})
                .to_string(),
        )
        .unwrap();
        write(
            &subagents,
            "agent-x2.jsonl",
            &[
                json!({"type": "user", "timestamp": "2026-11-10T10:00:05Z", "message": {"content": "Play"}}),
                assistant(
                    "2026-11-10T10:00:06Z",
                    json!([{"type": "tool_use", "id": "p1", "name": "Read", "input": {"file_path": "/x"}}]),
                ),
                result("2026-11-10T10:00:07Z", "p1", "ok", json!({})),
                json!({"type": "user", "timestamp": "2026-11-10T10:00:08Z", "message": {"content":
                    [{"type": "text", "text": "[Request interrupted by user for tool use]"}]}}),
            ],
        );

        // Written before Claude Code kept `finished`: it ends on its answer.
        fs::write(
            subagents.join("agent-x3.meta.json"),
            json!({"description": "Old one", "toolUseId": "a3"}).to_string(),
        )
        .unwrap();
        write(
            &subagents,
            "agent-x3.jsonl",
            &[
                json!({"type": "user", "timestamp": "2026-08-08T10:00:00Z", "message": {"content": "Look"}}),
                json!({"type": "assistant", "timestamp": "2026-08-08T10:00:09Z", "message": {"model": "claude-opus-4-1",
                    "stop_reason": "end_turn", "content": [{"type": "text", "text": "Found it."}]}}),
            ],
        );

        let board = board(&transcript);
        let old = board.loops.iter().find(|l| l.id == "x3").unwrap();
        assert_eq!(old.status, "completed");
        assert_eq!(old.ended_at.as_deref(), Some("2026-08-08T10:00:09Z"));
        let stopped = board.loops.iter().find(|l| l.id == "x2").unwrap();
        assert_eq!(stopped.status, "killed");
        assert_eq!(stopped.ended_at.as_deref(), Some("2026-11-10T10:00:08Z"));
        assert_eq!(stopped.current, None);
        let agent = board.loops.iter().find(|l| l.id == "x1").unwrap();
        assert_eq!(agent.shells[0].id, "bg1");
        assert_eq!(agent.shells[0].status, "completed");
        assert_eq!(
            agent.shells[0].ended_at.as_deref(),
            Some("2026-11-10T10:00:30Z")
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
