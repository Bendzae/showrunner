// Talking to showrunner, and what each item can do. Showrunner keeps projects,
// tasks and sessions; Herdr shows their terminals: a space per task, a tab per
// session (labels herdr.space / herdr.tab, set by showrunner).

import { exec, hc, readTextFile, appHome, home, notify, run, shared, setShared, spaces, agents, terminals } from "herdr";

// `local.json` beside this file can point at another binary or data folder
// (a development build): { "bin": "/path/to/showrunner", "home": "/path/to/.showrunner" },
// and at another binary on a machine: { "machines": { "devbox": { "bin": "…" } } }.
let config = null;
export async function loadConfig() {
  if (config) return config;
  let local = {};
  try {
    const text = await readTextFile(`${appHome()}/mods/showrunner/local.json`);
    if (text) local = JSON.parse(text);
  } catch {}
  config = { bin: local.bin ?? "showrunner", home: local.home ?? `${home()}/.showrunner`, ownHome: local.home ?? null, machines: local.machines ?? {} };
  return config;
}

// The machine a Herdr id or terminal address is on ("devbox/t3"), null for this one.
export const machineOf = (id) => (id?.includes("/") ? id.split("/")[0] : null);
// Herdr's id for a name showrunner on `machine` uses: other machines' carry its name.
export const qualify = (machine, id) => (machine && id ? `${machine}/${id}` : id);
// Back to the name showrunner on that machine knows.
export const bare = (machine, id) => (machine && id?.startsWith(`${machine}/`) ? id.slice(machine.length + 1) : id);

// The showrunner binary on a machine (null: this one).
export async function binOn(on) {
  const { bin, machines } = await loadConfig();
  return on ? machines[on]?.bin ?? "showrunner" : bin;
}

// `on`: run it on that machine, where session and run names (cm__…, cmrun-…)
// lose the machine's prefix.
export async function sr(args, timeout = 120000, on = null) {
  const { bin, ownHome } = await loadConfig();
  try {
    if (on) return await exec(await binOn(on), args.map((a) => (a.startsWith(`${on}/cm`) ? bare(on, a) : a)), { timeout, on });
    // Herdr's exec takes no environment: the data folder goes through env.
    return ownHome ? await exec("env", [`SHOWRUNNER_HOME=${ownHome}`, bin, ...args], { timeout }) : await exec(bin, args, { timeout });
  } catch (e) {
    return { code: 127, stdout: "", stderr: String(e?.message ?? e) };
  }
}

// hc's machines ({ name, target, via, state, why, … }), null when hc doesn't answer.
export async function hcMachines() {
  try {
    const r = await hc(["machine", "ls", "--json"]);
    if (r.code === 0) return JSON.parse(r.stdout).machines ?? [];
  } catch {}
  return null;
}

// Reconnecting a machine hc lost. Tailscale SSH in check mode holds each
// connection until someone logs in in a browser (every 12 hours by default)
// and names the page only in ssh's banner, which hc's background connections
// never show: hc just times out. So ssh here once, open that page when the
// banner names one, and once ssh gets in have hc log in again. `hc machine
// login` wants a terminal: `script` gives it one. No target (a machine hc
// reaches through another): hc logs in alone.
const RECONNECT = String.raw`
target=$1 name=$2
command -v hc >/dev/null 2>&1 || { echo "hc isn't on PATH" >&2; exit 127; }
if [ -n "$target" ]; then
  log=$(mktemp) || exit 1
  trap 'rm -f "$log"' EXIT
  ssh -o BatchMode=yes -o ConnectTimeout=20 "$target" true </dev/null 2>"$log" &
  pid=$! opened= waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ -z "$opened" ]; then
      url=$(grep -Eo 'https://login\.tailscale\.com/[^[:space:]]+' "$log" | head -n 1)
      if [ -n "$url" ]; then
        opened=1
        if command -v open >/dev/null 2>&1; then open "$url"; else xdg-open "$url" >/dev/null 2>&1 & fi
      fi
    fi
    if [ "$waited" -ge 300 ]; then
      kill "$pid" 2>/dev/null
      echo "Nobody approved the Tailscale login within 5 minutes." >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if ! wait "$pid"; then
    grep -v '^# ' "$log" >&2 || echo "ssh $target failed" >&2
    exit 1
  fi
fi
if [ "$(uname)" = Darwin ]; then
  script -q /dev/null hc machine login "$name" </dev/null
else
  NAME=$name script -qec 'hc machine login "$NAME"' /dev/null </dev/null
fi
`;

// Resolves with hc's machine afterwards (null if hc didn't answer) and what
// went wrong on the way.
export async function reconnectMachine(name) {
  const m = (await hcMachines())?.find((x) => x.name === name);
  let r;
  try {
    r = await exec("sh", ["-c", RECONNECT, "sh", m?.via ? "" : m?.target ?? "", name], { timeout: 330000 });
  } catch (e) {
    r = { code: 127, stdout: "", stderr: String(e?.message ?? e) };
  }
  const now = (await hcMachines())?.find((x) => x.name === name) ?? null;
  return { machine: now, error: clean(r.stderr) || (r.code !== 0 ? clean(r.stdout) : "") };
}

export function clean(text) {
  return (text ?? "").replace(/^Error:\s*/m, "").trim();
}

const firstLine = (text) => clean(text).split("\n")[0] || null;

// Operations in flight, for the status bar's spinner.
function busy(label, delta) {
  const now = [...(shared("showrunner.busy") ?? [])];
  if (delta > 0) now.push(label);
  else now.splice(now.indexOf(label), 1);
  setShared("showrunner.busy", now);
}

// Work for the tree to do. A popup's own tasks end when it closes, so popups
// queue what they start (through shared state) and the tree, which lives as
// long as the layout, runs it. Jobs: { kind: "act", label, args, opts },
// { kind: "perform", action, item }, { kind: "focus" }.
export function enqueue(job) {
  const queue = [...(shared("showrunner.queue") ?? [])];
  queue.push({ ...job, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, at: Date.now() });
  setShared("showrunner.queue", queue);
  run("showrunner.jobs");
}

// A showrunner command the way the TUI runs an operation: busy while it works,
// its outcome as a toast, then the tree looks again. `opts.after`:
// "reveal-created" shows the session a create printed; { reveal: { space, tab,
// focus } } shows that tab.
export function act(label, args, opts = {}) {
  enqueue({ kind: "act", label, args, opts });
}

export async function runAct({ label, args, opts = {} }) {
  busy(label, +1);
  const r = await sr(args, opts.timeout, opts.on);
  busy(label, -1);
  run("showrunner.refresh");
  if (r.code === 0) {
    if (!opts.quiet) notify({ title: opts.success ?? firstLine(r.stdout) ?? label, level: "success", timeout: 4000 });
    if (opts.after === "reveal-created") revealCreated(r, opts.on);
    else if (opts.after?.reveal) reveal(opts.after.reveal.space, opts.after.reveal.tab, opts.after.reveal.focus);
  } else {
    notify({ title: `${label} failed`, body: clean(r.stderr) || clean(r.stdout) || `exit ${r.code}`, level: "error", timeout: 9000 });
  }
  return r;
}

// Statuses, most urgent first. "error" is a turn that failed: the person is needed.
export const RANK = { blocked: 4, working: 3, done: 2, idle: 1 };
export function worst(statuses) {
  let best = null;
  for (const s of statuses) if (s && (RANK[s] ?? 0) > (RANK[best] ?? 0)) best = s;
  return best;
}

// Live facts per session terminal: its address and status. Herdr's agents()
// knows "done" (finished while you weren't looking); a terminal it doesn't show
// has hc's own word; agents without a status report get showrunner's guess.
// Keyed by Herdr's name for the session (another machine's carry its name).
export function liveSessions(guessed = {}) {
  const byAddress = new Map(agents().map((a) => [a.address, a]));
  const out = {};
  for (const t of terminals()) {
    const label = t.labels?.["showrunner.session"];
    if (!label || t.state !== "live") continue;
    const name = qualify(machineOf(t.address), label);
    // A kept terminal whose agent was lost runs a recovered shell: ended.
    if (!(t.argv?.[2] ?? "").startsWith("exec ")) continue;
    const agent = byAddress.get(t.address);
    let status = agent?.status ?? (t.status === "error" ? "blocked" : t.status) ?? null;
    if (!status && guessed[name]) status = guessed[name];
    out[name] = { address: t.address, status, program: t.program ?? agent?.program, pane: agent?.pane };
  }
  return out;
}

// Run terminals by their name, and whether their command still runs.
export function liveRuns() {
  const out = {};
  for (const t of terminals()) {
    const label = t.labels?.["showrunner.run"];
    if (!label || t.state !== "live") continue;
    out[qualify(machineOf(t.address), label)] = { address: t.address, running: !isShellIdle(t) };
  }
  return out;
}

function isShellIdle(t) {
  const name = t.foreground?.name ?? "";
  const argv = t.foreground?.argv ?? [];
  const shell = /^-?(sh|bash|zsh|fish|dash|ksh|tcsh|csh)$/.test(name);
  return shell && !argv.includes("-c");
}

// The TUI's showrunner statuses for agents that don't report their own.
export function guessedStatus(word) {
  return { running: "working", waiting_permission: "blocked", waiting_input: "idle", finished: null }[word] ?? null;
}

// Show a session: its space, its tab, and with `focus` its terminal gets the keyboard.
export function show(space, tab, address, focus) {
  if (space && spaces().some((s) => s.id === space)) run("space.select", { id: space });
  if (tab) run("tab.select", { id: tab });
  if (focus && address) run("pane.focus", { terminal: address });
}

// Show a tab Herdr may not know yet (a session or run just started): the tree
// shows it once it appears.
export function reveal(space, tab, focus) {
  setShared("showrunner.reveal", { space, tab, focus: !!focus, until: Date.now() + 15000 });
}

// After a create: the session it printed ("main session: p/t/s", "created
// session: p/t/s"), shown. `on`: the machine it was created on.
export function revealCreated(r, on) {
  const ref = r?.code === 0 && /session: (\S+)\s*$/m.exec(r.stdout)?.[1];
  if (!ref) return;
  const parts = ref.split("/");
  reveal(qualify(on, `cm__${parts.slice(0, 2).join("__")}`), qualify(on, `cm__${parts.join("__")}`), false);
}

export function copy(text, what) {
  exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text])
    .then((r) => notify({ title: r.code === 0 ? `Copied ${what}` : "Copy failed", body: text, level: r.code === 0 ? "success" : "error", timeout: 3000 }))
    .catch(() => {});
}

export function openUrl(url) {
  exec("open", [url]).catch(() => {});
}

export const sessionRef = (s) => s.cm_name;
export const taskRef = (project, task) => `${project.name}/${task.name}`;

// What `a` offers on an item, in the TUI's order and with its keys.
// `item`: { kind, project, task?, group?, session?, run?, archivedView }.
export function menuItems(item) {
  const { kind, task, session } = item;
  const runItem = { key: "x", label: "Run", action: "run" };
  const remote = (s) =>
    s && s.agent === "claude" && s.live
      ? [{ key: "R", label: s.remote_control ? "Disable Remote Control" : "Enable Remote Control", action: "remote-control" }]
      : [];
  switch (kind) {
    case "project":
      return [
        { key: "t", label: "Add task", action: "add-task" },
        { key: "T", label: "Add task (choose agent)", action: "add-task-agent" },
        { key: "l", label: "Add task from Linear ticket", action: "add-task-ticket" },
        { key: "A", label: "New adhoc session", action: "new-adhoc" },
        runItem,
        { key: "b", label: "Checkout branch", action: "checkout-branch" },
        { key: "f", label: "Fetch & pull all branches", action: "fetch" },
        { key: "y", label: "Copy path", action: "copy-path" },
        { key: "d", label: "Delete", action: "delete", danger: true },
      ];
    case "adhoc-group":
      return [{ key: "A", label: "New adhoc session", action: "new-adhoc" }];
    case "machine":
      return [{ key: "p", label: "Add project", action: "add-project" }];
    case "group":
      return [
        { key: "t", label: "Add task to group", action: "add-task" },
        { key: "g", label: "Rename group", action: "rename-group" },
        { key: "G", label: "Ungroup tasks", action: "ungroup" },
      ];
    case "adhoc":
      return [runItem, ...remote(session), { key: "d", label: "Delete", action: "delete", danger: true }];
    case "task": {
      if (task.archived)
        return [
          { key: "A", label: "Unarchive", action: "unarchive" },
          { key: "d", label: "Delete", action: "delete", danger: true },
        ];
      return [
        { key: "n", label: "New session", action: "new-session" },
        { key: "N", label: "New session (no worktree)", action: "new-session-no-worktree" },
        { key: "S", label: "New session (choose agent)", action: "new-session-agent" },
        { key: "r", label: "Review diff", action: "review" },
        runItem,
        { key: "u", label: "Update branch", action: "update" },
        { key: "B", label: "Set base branch", action: "set-base" },
        { key: "P", label: "Push", action: "push" },
        { key: "b", label: "Checkout", action: "checkout-task" },
        { key: "o", label: "Open PR", action: "open-pr" },
        { key: "g", label: "Set group", action: "set-group" },
        ...(task.linear ? [{ key: "l", label: "Open Linear ticket", action: "open-linear" }] : []),
        ...remote(item.main),
        { key: "A", label: "Archive", action: "archive" },
        { key: "d", label: "Delete", action: "delete", danger: true },
      ];
    }
    case "session": {
      const main = session.name === "main";
      return [
        { key: "r", label: "Review uncommitted changes", action: "review" },
        ...(main ? [] : [
          { key: "m", label: "Merge into task branch", action: "merge" },
          { key: "u", label: "Update", action: "update-session" },
        ]),
        { key: "t", label: "Terminal", action: "terminal" },
        runItem,
        { key: "y", label: "Copy worktree path", action: "copy-path" },
        ...remote(session),
        ...(main ? [] : [{ key: "d", label: "Delete", action: "delete", danger: true }]),
      ];
    }
    case "stopped":
      return [
        { key: "s", label: "Start (resume its conversation)", action: "resume" },
        { key: "d", label: "Delete", action: "delete", danger: true },
      ];
    default:
      return [];
  }
}

// The run terminal's own menu, as the TUI offers once one is live.
export const RUN_MENU = [
  { key: "a", label: "Attach", action: "run-attach" },
  { key: "r", label: "Restart", action: "run-restart" },
  { key: "k", label: "Kill", action: "run-kill", danger: true },
];
