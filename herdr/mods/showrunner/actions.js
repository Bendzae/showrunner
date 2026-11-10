// What each menu action does: open a form, picker or confirmation, run a
// showrunner command, or move Herdr (show a tab, open a terminal beside one).

import { exec, run, openOverlay, notify, knownAgents, panes } from "herdr";
import { act, sr, clean, show, copy, openUrl, liveRuns, loadConfig, RUN_MENU, taskRef } from "./lib.js";
import { showPanel } from "./panels.js";

const MOD = "showrunner";

function overlay(view, props, size) {
  return openOverlay({ mod: MOD, kind: "dialog", width: size?.width ?? 460, height: size?.height, props: { view, ...props } });
}

export function openMenu(item, at, entries) {
  openOverlay({
    mod: MOD,
    kind: "popup",
    width: 300,
    height: 520,
    ...(at ? { at } : {}),
    props: { view: "menu", item, entries: entries ?? null },
  });
}

// As tall as its fields: a dialog doesn't size itself to its content.
function formHeight(spec, props) {
  let h = 128;
  for (const f of spec.fields) h += (f.multiline ? 142 : 70) + (f.id === "path" ? 38 : 0);
  const hint = typeof spec.hint === "function" ? spec.hint(props) : spec.hint;
  if (hint) h += 12 + 18 * Math.ceil(hint.length / 72);
  return h;
}

export const form = (name, item, extra) => {
  const props = { form: name, item, ...extra };
  return overlay("form", props, { width: 520, height: formHeight(FORMS[name], props) });
};
export const picker = (name, item, extra) => overlay("picker", { picker: name, item, ...extra }, { width: 480, height: 440 });
export const confirm = (title, detail, args, label) =>
  overlay("confirm", { title, detail, args, label }, { width: 440, height: 190 });

// The ref `run` and `review` take for an item.
function itemRef(item) {
  if (item.session) return item.session.cm_name;
  if (item.task) return taskRef(item.project, item.task);
  return item.project.name;
}

// A task's tab to put things beside: the selected session's, else its main one.
function anchorTab(item) {
  return item.session?.cm_name ?? item.main?.cm_name ?? null;
}

// `at`: where a menu it opens goes (beside the tree's selection).
export async function perform(action, item, at) {
  const { project, task, session, group } = item;
  switch (action) {
    case "show":
      return show(item.space, session?.cm_name, session?.address, false);
    case "add-task":
      return form("add-task", item, { group: group ?? null });
    case "add-task-agent":
      return form("add-task", item, { group: group ?? null, chooseAgent: true });
    case "add-task-ticket":
      return form("ticket", item);
    case "new-adhoc":
      return form("adhoc", item);
    case "new-session":
      return form("session", item, { worktree: true });
    case "new-session-no-worktree":
      return form("session", item, { worktree: false });
    case "new-session-agent":
      return form("session", item, { worktree: true, chooseAgent: true });
    case "rename-group":
      return form("rename-group", item);
    case "ungroup":
      return act("Ungrouping", ["group", "ungroup", project.name, group], { success: `Group '${group}' dissolved` });
    case "set-group":
      return picker("group", item);
    case "set-base":
      return picker("base", item);
    case "checkout-branch":
      return picker("branch", item);
    case "fetch":
      return act(`Fetching all branches for ${project.name}`, ["project", "fetch", project.name], { timeout: 300000 });
    case "copy-path":
      return copy(session?.worktree ?? project.path, session ? "worktree path" : "project path");
    case "update":
      return act("Updating task branch", ["task", "update", project.name, task.name], { timeout: 300000 });
    case "push":
      return act("Pushing", ["task", "push", project.name, task.name], { timeout: 300000 });
    case "checkout-task":
      return act("Checking out", ["task", "checkout", project.name, task.name]);
    case "open-pr":
      if (task.pr?.url) return openUrl(task.pr.url);
      return confirm("No PR found", `Create a draft PR for ${task.branch}? Its branch is pushed first.`,
        ["task", "pr", project.name, task.name, "--create"], "Create PR");
    case "open-linear":
      return showPanel("ticket");
    case "archive":
      return act("Archiving task", ["task", "archive", project.name, task.name]);
    case "unarchive":
      return act("Unarchiving task", ["task", "unarchive", project.name, task.name], { timeout: 300000 });
    case "remote-control":
      return act("Toggling Remote Control", ["session", "remote-control", (session ?? item.main).cm_name]);
    case "update-session":
      return act("Updating session", ["session", "update", session.cm_name], { timeout: 300000 });
    case "merge":
      return merge(item);
    case "resume":
      if (session.in_tmux)
        return notify({ title: `${session.name} still runs in tmux`, body: "Move it here with `showrunner migrate`, from a terminal outside tmux.", level: "warning", timeout: 8000 });
      return act("Starting session", ["session", "resume", session.cm_name],
        { success: `Started ${session.name}`, after: { reveal: { space: item.space, tab: session.cm_name, focus: true } } });
    case "delete":
      return remove(item);
    case "terminal": {
      // A shell already open beside the session is reused, as the TUI does.
      show(item.space, session.cm_name, session.address, false);
      const shell = panes().find((p) => p.tab === session.cm_name && p.terminal && p.terminal !== session.address && p.program?.shell);
      if (shell) return run("pane.focus", { pane: shell.pane });
      return run("terminal.open", { folder: session.worktree ?? project.path, place: "right" });
    }
    case "review":
      return review(item);
    case "run":
      return runCommand(item, at);
    case "run-attach": {
      const live = liveRuns()[item.run];
      return show(item.space, item.run, live?.address, true);
    }
    case "run-restart":
      return startRun(item);
    case "run-kill":
      return act("Stopping run", ["run", itemRef(item), "--kill"], { success: "Run session killed" });
  }
}

async function merge(item) {
  const { session } = item;
  const status = await exec("git", ["status", "--porcelain"], { cwd: session.worktree }).catch(() => null);
  if (status && status.stdout.trim()) return form("merge", item);
  return act("Merging", ["session", "merge", session.cm_name], { timeout: 300000 });
}

// The TUI's own wording for what a delete takes with it.
function remove(item) {
  const { kind, project, task, session } = item;
  switch (kind) {
    case "project": {
      const sessions = item.counts?.sessions ?? 0, tasks = item.counts?.tasks ?? 0;
      return confirm(`Delete ${project.name}?`,
        sessions || tasks ? `Its ${tasks} task(s) and ${sessions} session(s) go too: their worktrees and branches are removed. The repository stays.` : "The repository stays.",
        ["project", "delete", project.name, "--yes"], "Delete project");
    }
    case "task": {
      const live = item.counts?.sessions ?? 0;
      return confirm(`Delete ${task.name}?`,
        live ? `Kills its ${live} session(s) and removes their worktrees and branches, the task branch too.` : "Removes its worktrees and branches, the task branch too.",
        ["task", "delete", project.name, task.name, "--yes"], "Delete task");
    }
    case "session":
    case "adhoc":
    case "stopped":
      return confirm(`Delete ${kind === "adhoc" ? "adhoc session" : "session"} ${session.name}?`,
        kind === "adhoc" || !session.worktree ? "Ends its agent." : "Ends its agent and removes its worktree and branch, with any unmerged work.",
        ["session", "kill", session.cm_name, "--yes"], "Delete session");
  }
}

// Review in a pane beside the agent, zoomed: the tool runs there and sends the
// comments to the agent when it closes.
async function review(item) {
  const { bin } = await loadConfig();
  const tab = anchorTab(item);
  if (!tab) return notify({ title: "No session to review beside", level: "warning", timeout: 4000 });
  const address = item.session?.address ?? item.main?.address;
  show(item.space, tab, address, true);
  run("pane.split", { direction: "right", argv: [bin, "review", itemRef(item)] });
  run("pane.zoom", {});
}

function runCommand(item, at) {
  const live = liveRuns()[item.run];
  if (live) return openMenu(item, at, RUN_MENU);
  if (!item.project.run_command) return form("run-command", item);
  return startRun(item);
}

export function startRun(item, command) {
  const args = ["run", itemRef(item), ...(command ? ["--command", command] : [])];
  act("Starting run", args, { success: `Running: ${command ?? item.project.run_command}`, after: { reveal: { space: item.space, tab: item.run, focus: true } } });
}

// The agents a form offers, as the program table draws them. Drawn at once;
// whether each is installed arrives later (asking the shell takes a moment).
const AGENTS = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "pi", name: "Pi" },
];
export function agentChoices(known) {
  return AGENTS.map((a) => {
    const p = known?.find((k) => k.key === a.id || k.run?.[0] === a.id);
    return { ...a, name: p?.name ?? a.name, icon: p?.icon ?? `icons/${a.id}.svg`, tint: p?.tint ?? false, installed: p?.installed ?? true };
  });
}

export const loadKnownAgents = () => knownAgents().catch(() => null);

// Forms: their fields and what submitting runs.
export const FORMS = {
  project: {
    title: () => "Add a project",
    action: "Add project",
    fields: [
      { id: "path", label: "Folder", placeholder: "~/code/my-app" },
      { id: "name", label: "Name", placeholder: "The folder's name" },
    ],
    hint: "A git repository. Its tasks get worktrees under showrunner's folder; the repository itself stays as it is.",
    submit: (v) => {
      if (!v.path.trim()) return "Which folder?";
      const args = ["project", "add", v.path.trim()];
      if (v.name.trim()) args.push("--name", v.name.trim());
      act("Adding project", args);
    },
  },
  "add-task": {
    action: "Create task",
    title: (p) => (p.group ? `New task in ${p.group}` : `New task in ${p.item.project.name}`),
    fields: [
      { id: "name", label: "Name", placeholder: "Fix the login redirect" },
      { id: "branch", label: "Branch", placeholder: "derived from the name", derive: "name" },
      { id: "prompt", label: "First prompt", placeholder: "Optional: what the main session starts on", multiline: true },
      { id: "agent", label: "Agent", agent: true },
    ],
    submit: (v, p) => {
      if (!v.name.trim()) return "A task needs a name";
      if (v.name.trim().toLowerCase() === "adhoc") return "'adhoc' is reserved — pick a different task name";
      const branch = v.branch.trim() || toBranch(v.name);
      if (branch === "main" || branch === "master") return "Can't use 'main' or 'master' as a task branch";
      const args = ["task", "create", p.item.project.name, v.name.trim(), "--branch", branch, "--agent", v.agent];
      if (p.group) args.push("--group", p.group);
      if (v.prompt.trim()) args.push("--prompt", v.prompt.trim());
      act(`Creating task ${v.name.trim()}`, args, { timeout: 300000, after: "reveal-created" });
    },
  },
  ticket: {
    title: () => "New task from a Linear ticket",
    action: "Create task",
    fields: [
      { id: "ticket", label: "Ticket", placeholder: "ENG-123 or its URL" },
      { id: "agent", label: "Agent", agent: true },
    ],
    hint: "Named after the ticket, on its branch, linked to it, with the main session starting on it.",
    submit: (v, p) => {
      if (!v.ticket.trim()) return "Which ticket?";
      act("Creating task from Linear ticket", ["task", "from-ticket", p.item.project.name, v.ticket.trim(), "--agent", v.agent], { timeout: 300000, after: "reveal-created" });
    },
  },
  adhoc: {
    title: (p) => `New adhoc session in ${p.item.project.name}`,
    action: "Start session",
    fields: [
      { id: "name", label: "Name", placeholder: "scratch" },
      { id: "agent", label: "Agent", agent: true },
    ],
    hint: "Runs in the project folder, on whatever branch is checked out there.",
    submit: (v, p) => {
      if (!v.name.trim()) return "An adhoc session needs a name";
      act("Creating adhoc session", ["session", "adhoc", p.item.project.name, v.name.trim(), "--agent", v.agent], { timeout: 300000, after: "reveal-created" });
    },
  },
  session: {
    title: (p) => `New session in ${p.item.task.name}${p.worktree ? "" : " (no worktree)"}`,
    action: "Start session",
    fields: [
      { id: "prompt", label: "First prompt", placeholder: "Optional", multiline: true },
      { id: "agent", label: "Agent", agent: true },
    ],
    hint: (p) => (p.worktree ? `Works on its own branch off ${p.item.task.branch}.` : "Works in the project folder, without a worktree."),
    submit: (v, p) => {
      const args = ["session", "create", p.item.project.name, p.item.task.name, "--agent", v.agent];
      if (!p.worktree) args.push("--no-worktree");
      if (v.prompt.trim()) args.push("--prompt", v.prompt.trim());
      act("Creating session", args, { timeout: 300000, after: "reveal-created" });
    },
  },
  "rename-group": {
    title: (p) => `Rename ${p.item.group}`,
    action: "Rename",
    fields: [{ id: "name", label: "Name", value: (p) => p.item.group }],
    submit: (v, p) => {
      if (!v.name.trim()) return "Group name cannot be empty";
      act("Renaming group", ["group", "rename", p.item.project.name, p.item.group, v.name.trim()]);
    },
  },
  "run-command": {
    title: (p) => `Run command for ${p.item.project.name}`,
    action: "Run",
    fields: [{ id: "command", label: "Command", placeholder: "npm run dev" }],
    hint: "Saved to the project and used for every Run there.",
    submit: (v, p) => {
      if (!v.command.trim()) return "Run cancelled (no command entered)";
      startRun(p.item, v.command.trim());
    },
  },
  merge: {
    title: (p) => `Merge session ${p.item.session.name} into ${p.item.task.branch}`,
    action: "Commit & merge",
    fields: [{ id: "message", label: "Commit message", placeholder: "Leave empty for the default" }],
    hint: "Its worktree has uncommitted changes: they're committed first.",
    submit: (v, p) => {
      const args = ["session", "merge", p.item.session.cm_name];
      if (v.message.trim()) args.push("--message", v.message.trim());
      act("Merging", args, { timeout: 300000 });
    },
  },
};

// Pickers: what they list and what picking does.
export const PICKERS = {
  branch: {
    title: (p) => `Checkout a branch in ${p.item.project.name}`,
    load: async (p) => branches(p.item.project.name),
    pick: (value, p) => act(`Checking out ${value}`, ["project", "checkout", p.item.project.name, value]),
  },
  base: {
    title: (p) => `Base branch for ${p.item.task.name}`,
    load: async (p) => {
      const list = await branches(p.item.project.name);
      return ["main", ...list.filter((b) => b !== "main" && b !== p.item.task.branch)];
    },
    current: (p) => p.item.task.base_branch,
    pick: (value, p) => act("Setting base branch", ["task", "set-base", p.item.project.name, p.item.task.name, value]),
  },
  group: {
    title: (p) => `Group for ${p.item.task.name}`,
    load: async (p) => ["No group", ...(p.item.groups ?? [])],
    current: (p) => p.item.task.group ?? "No group",
    create: true,
    pick: (value, p) => {
      const args = ["task", "set-group", p.item.project.name, p.item.task.name];
      if (value !== "No group") args.push(value);
      act("Setting group", args);
    },
  },
};

async function branches(project) {
  const r = await sr(["project", "branches", project]);
  if (r.code !== 0) throw new Error(clean(r.stderr));
  return r.stdout.split("\n").map((b) => b.trim()).filter(Boolean);
}

// The TUI's branch name for a task name.
export function toBranch(name) {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}
