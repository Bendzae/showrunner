// The sidebar: projects, task groups, tasks and their sessions, as the TUI
// lists them, with the TUI's keys. Statuses are Herdr's live ones; structure,
// diffs and PRs come from `showrunner list`.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, focused, run, theme, settings, shared, setShared, nextCommand, readTextFile, window, layout, themes, openOverlay } from "herdr";
import { sr, clean, loadConfig, liveSessions, liveRuns, guessedStatus, worst, menuItems, show, runAct } from "./lib.js";
import { perform, openMenu, form } from "./actions.js";
import { togglePanel, showPanel, panelEntries } from "./panels.js";
import { icon, programIcon, statusGlyph, prColor, diffBadge, activityBadge, avatar, avatarColor, linearId, prSummary } from "./ui.js";

const H = { project: 34, group: 26, task: 28, session: 26, stopped: 26, "adhoc-group": 26, adhoc: 26, "other-head": 32, space: 28, hint: 30 };
const HOT_SECONDS = 2 * 3600;
const HEADER = 31;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Where the tree's block starts in the window: the sidebar's blocks above it.
function blockTop() {
  const sidebar = find(layout(), "sidebar");
  let y = 0;
  for (const child of sidebar?.children ?? []) {
    if (find(child, "showrunner")) break;
    y += child.hidden ? 0 : child.size?.px ?? 0;
  }
  return y;
}

export class Tree {
  init(cx) {
    this.handle = cx.focus_handle();
    this.data = null;
    this.error = null;
    this.stats = { projects: {}, tasks: {}, sessions: {} };
    this.guessed = {};
    // Folded unless opened: projects, groups, tasks and adhoc start closed.
    this.expanded = new Set(JSON.parse(localStorage.getItem("expanded") ?? "[]"));
    this.archived = false;
    this.filtering = false;
    this.filter = "";
    this.sel = localStorage.getItem("selected");
    this.scroll = 0;
    this.listHeight = 600;
    this.renamed = new Set();
    this.lastStatus = {};
    this.input = InputState.new({ placeholder: "Filter projects, tasks, sessions…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.scroll = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => { this.handle.focus(); cx.notify(); });
    // Operations a previous run was waiting on are gone with it.
    setShared("showrunner.busy", []);
    // Herdr's tab bar remembers the right panel per space for the views listed here.
    const panels = shared("workspace.panels") ?? ["files", "changes"];
    const missing = ["ideas", "pr", "ticket"].filter((v) => !panels.includes(v));
    if (missing.length) setShared("workspace.panels", [...panels, ...missing]);

    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(c, cx);
        cx.notify();
      }
    });
    // Like the TUI's start: sessions saved but not running (a reboot) come back.
    cx.spawn(async (cx) => {
      await loadConfig();
      await sr(["restore"]);
      this.refresh(cx);
      this.refreshStats(cx);
    });
    // Herdr moving the keyboard away (Ctrl-B l) tells the tree nothing: the
    // selection would stay lit and the tree wouldn't follow the tabs.
    cx.timer.every(150, (cx) => {
      const focused = this.handle.is_focused();
      if (focused !== this.wasFocused) { this.wasFocused = focused; cx.notify(); }
    });
    cx.timer.every(1500, (cx) => this.watch(cx));
    cx.timer.every(30000, (cx) => this.refresh(cx));
    cx.timer.every(20000, (cx) => { if (window()?.active) this.refreshStats(cx); });
    cx.timer.every(4000, (cx) => this.refreshGuesses(cx));
  }

  command(c, cx) {
    if (c === "focus") this.handle.focus();
    else if (c === "toggle") this.handle.is_focused() ? this.leave() : this.handle.focus();
    else if (c === "refresh") this.refresh(cx);
    else if (c === "jobs") this.runJobs(cx);
    else if (c === "panels") this.panelMenu();
    // `showrunner.select:<row key>`, e.g. `s:cm__app__fix__main` or `t:app/Fix login`.
    else if (c.startsWith("select:")) { this.expandTo(c.slice(7)); this.select(c.slice(7)); this.handle.focus(); }
  }

  // Which right panel to show, from anywhere (⌃'); the keyboard goes back
  // where it was.
  panelMenu() {
    const entries = panelEntries();
    const back = this.handle.is_focused() ? "tree" : focused()?.pane ?? null;
    openOverlay({ mod: "showrunner", kind: "dialog", width: 280, height: 48 + entries.length * 30, props: { view: "menu", title: "Right panel", entries, back } });
  }

  // Back to the terminal on screen.
  leave() {
    const f = focused();
    if (f?.pane) run("pane.focus", { pane: f.pane });
  }

  // config.toml and sessions.json, read often: a CLI call (an agent creating a
  // task) shows up at once.
  watch(cx) {
    if (this.watching) return;
    this.watching = true;
    cx.spawn(async (cx) => {
      const { home } = await loadConfig();
      const read = (f) => readTextFile(`${home}/${f}`).catch(() => null);
      const text = `${await read("config.toml")}\0${await read("sessions.json")}`;
      this.watching = false;
      if (this.seen !== undefined && text !== this.seen) this.refresh(cx);
      this.seen = text;
    });
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      const r = await sr(["list", "--json", "--no-status", "--local"]);
      this.loading = false;
      if (r.code === 0) {
        try { this.data = JSON.parse(r.stdout); this.error = null; } catch (e) { this.error = `Unreadable listing: ${e}`; }
      } else {
        this.error = clean(r.stderr) || "showrunner did not answer";
      }
      cx.notify();
      if (this.again) { this.again = false; this.refresh(cx); }
    });
  }

  // Diffs, branches, PRs, last activity: what the TUI's worker computes.
  refreshStats(cx) {
    if (this.statsLoading) return;
    this.statsLoading = true;
    cx.spawn(async (cx) => {
      const r = await sr(["list", "--json", "--stats", "--no-status", "--local"], 180000);
      this.statsLoading = false;
      if (r.code !== 0) return;
      let data;
      try { data = JSON.parse(r.stdout); } catch { return; }
      const stats = { projects: {}, tasks: {}, sessions: {} };
      for (const p of data.projects ?? []) {
        stats.projects[p.name] = { branch: p.branch };
        const sessions = [...(p.adhoc_sessions ?? [])];
        for (const t of p.tasks ?? []) {
          stats.tasks[`${p.name}/${t.name}`] = { diff: t.diff, pr: t.pr };
          sessions.push(...(t.sessions ?? []));
        }
        for (const s of sessions) stats.sessions[s.cm_name] = { diff: s.diff, branch: s.branch, last_active: s.last_active };
      }
      this.stats = stats;
      cx.notify();
    });
  }

  // Agents that don't report a status (codex, pi): showrunner reads their screens.
  refreshGuesses(cx) {
    if (this.guessing || !this.data) return;
    const live = liveSessions();
    const silent = Object.values(live).some((s) => !s.status);
    if (!silent) { this.guessed = {}; return; }
    this.guessing = true;
    cx.spawn(async (cx) => {
      const r = await sr(["list", "--json", "--local"]);
      this.guessing = false;
      if (r.code !== 0) return;
      const guessed = {};
      try {
        for (const p of JSON.parse(r.stdout).projects ?? [])
          for (const s of [...(p.adhoc_sessions ?? []), ...(p.tasks ?? []).flatMap((t) => t.sessions ?? [])])
            guessed[s.cm_name] = guessedStatus(s.status);
      } catch { return; }
      this.guessed = guessed;
      cx.notify();
    });
  }

  toggle(key) {
    this.expanded.has(key) ? this.expanded.delete(key) : this.expanded.add(key);
    localStorage.setItem("expanded", JSON.stringify([...this.expanded]));
  }

  // Open the rows above a row, so it shows.
  expandTo(key) {
    const row = this.allRows?.find((r) => r.key === key);
    for (const parent of row?.parents ?? []) if (!this.expanded.has(parent)) this.toggle(parent);
  }

  // Every row, in order, as the TUI lists them; `allRows` keeps the ones
  // folded away, the result leaves them out.
  build(live) {
    const rows = [];
    this.names = {};
    this.spaceOrder = [];
    this.tabOrder = [];
    const f = this.filter.trim().toLowerCase();
    const has = (...xs) => !f || xs.some((x) => (x ?? "").toLowerCase().includes(f));
    // A filter opens everything, so its matches show.
    const open = (key) => Boolean(f) || this.expanded.has(key);
    const sessionInfo = (s, stopped) => ({
      cm_name: s.cm_name, name: s.name, agent: s.agent, worktree: s.worktree ?? null,
      run: s.run ?? null, live: !stopped && Boolean(live[s.cm_name]), address: live[s.cm_name]?.address ?? null,
      remote_control: s.remote_control ?? false,
      in_tmux: Boolean(stopped && s.in_tmux),
    });
    for (const p of this.data?.projects ?? []) {
      const P = { name: p.name, path: p.path, run_command: p.run_command, space: p.space, run: p.run, agent: this.data.default_agent ?? "claude" };
      const pkey = `p:${p.name}`;
      const projectHit = has(p.name);
      const tasks = (p.tasks ?? []).filter((t) => Boolean(t.archived) === this.archived);
      const projectRows = [];
      let sessionsTotal = 0;
      let lastGroup = null;
      // Adhoc sessions, the project's own space: always first, also when empty.
      if (!this.archived) {
        const running = (p.adhoc_sessions ?? []).filter((s) => live[s.cm_name]);
        const stopped = [...(p.adhoc_stopped ?? []), ...(p.adhoc_sessions ?? []).filter((s) => !live[s.cm_name])];
        const hits = [...running.map((s) => [s, false]), ...stopped.map((s) => [s, true])].filter(([s]) => projectHit || has(s.name, "adhoc"));
        this.names[p.space] = p.name;
        this.names[p.run] = "▶ run";
        if (hits.length) this.spaceOrder.push(p.space);
        if (hits.length || !f) {
          const akey = `a:${p.name}`;
          const status = worst(running.map((s) => live[s.cm_name].status));
          sessionsTotal += running.length;
          projectRows.push({ key: akey, kind: "adhoc-group", depth: 1, parents: [pkey], status, folded: !open(akey), count: hits.length,
            item: { kind: "adhoc-group", project: P, space: p.space } });
          for (const [s, isStopped] of hits) {
            this.names[s.cm_name] = s.name;
            this.tabOrder.push(s.cm_name);
            projectRows.push({
              key: `s:${s.cm_name}`, kind: isStopped ? "stopped" : "adhoc", depth: 2, parents: [pkey, akey],
              item: { kind: isStopped ? "stopped" : "adhoc", project: P, session: sessionInfo(s, isStopped), space: p.space, run: s.run },
              status: isStopped ? "stopped" : live[s.cm_name]?.status, program: live[s.cm_name]?.program,
              diff: this.stats.sessions[s.cm_name]?.diff,
            });
          }
        }
      }
      for (const t of tasks) {
        const T = { name: t.name, branch: t.branch, base_branch: t.base_branch, linear: t.linear, group: t.group, archived: t.archived, pr: this.stats.tasks[`${p.name}/${t.name}`]?.pr ?? null, stack: t.stack };
        const space = t.space;
        this.spaceOrder.push(space);
        this.names[space] = t.name;
        const running = (t.sessions ?? []).filter((s) => live[s.cm_name]);
        // A session listed as live that Herdr has seen end is stopped now.
        const stopped = [...(t.stopped ?? []), ...(t.sessions ?? []).filter((s) => !live[s.cm_name])];
        const statuses = running.map((s) => live[s.cm_name].status);
        const status = worst(statuses);
        sessionsTotal += running.length;
        const main = running.find((s) => s.name === "main");
        const taskHit = projectHit || has(t.name, t.branch, linearId(t.linear));
        const sessionHits = [...running, ...stopped].filter((s) => taskHit || has(s.name, s.agent));
        if (!taskHit && !sessionHits.length) continue;
        if (t.group && t.group !== lastGroup) {
          const gkey = `g:${p.name}/${t.group}`;
          const groupTasks = tasks.filter((x) => x.group === t.group);
          projectRows.push({ key: gkey, kind: "group", depth: 1, parents: [pkey], label: t.group, count: groupTasks.length,
            item: { kind: "group", project: P, group: t.group, space: p.space }, folded: !open(gkey) });
        }
        lastGroup = t.group ?? null;
        const inGroup = Boolean(t.group);
        const above = inGroup ? [pkey, `g:${p.name}/${t.group}`] : [pkey];
        const tkey = `t:${p.name}/${t.name}`;
        const mainInfo = main ? sessionInfo(main, false) : null;
        const taskItem = { kind: "task", project: P, task: T, space, run: t.run, main: mainInfo, counts: { sessions: running.length } };
        projectRows.push({ key: tkey, kind: "task", depth: inGroup ? 2 : 1, parents: above, item: taskItem, status, folded: !open(tkey),
          blocked: statuses.filter((s) => s === "blocked").length, diff: this.stats.tasks[`${p.name}/${t.name}`]?.diff });
        const ordered = [...running.map((s) => [s, false]), ...stopped.map((s) => [s, true])]
          .filter(([s]) => sessionHits.includes(s))
          .sort(([a], [b]) => (a.name !== "main") - (b.name !== "main") || a.name.localeCompare(b.name, undefined, { numeric: true }));
        for (const [s, isStopped] of ordered) {
          this.names[s.cm_name] = s.name === "main" ? "main" : /^\d+$/.test(s.name) ? `session ${s.name}` : s.name;
          this.tabOrder.push(s.cm_name);
          const S = sessionInfo(s, isStopped);
          projectRows.push({
            key: `s:${s.cm_name}`, kind: isStopped ? "stopped" : "session", depth: (inGroup ? 2 : 1) + 1, parents: [...above, tkey],
            item: { kind: isStopped ? "stopped" : "session", project: P, task: T, session: S, space, run: s.run, main: mainInfo },
            status: isStopped ? "stopped" : live[s.cm_name]?.status, program: live[s.cm_name]?.program,
            diff: this.stats.sessions[s.cm_name]?.diff, branch: this.stats.sessions[s.cm_name]?.branch,
          });
          if (s.run) this.names[s.run] = "▶ run";
        }
        this.names[t.run] = "▶ run";
      }
      if (!projectHit && !projectRows.length) continue;
      rows.push({ key: pkey, kind: "project", depth: 0, folded: !open(pkey), branch: this.stats.projects[p.name]?.branch,
        item: { kind: "project", project: P, space: p.space, run: p.run, counts: { tasks: (p.tasks ?? []).length, sessions: sessionsTotal } } });
      rows.push(...projectRows);
    }
    // Herdr spaces that aren't showrunner's (a plain terminal, another agent).
    const others = spaces().filter((s) => !s.id.startsWith("cm__") && !s.machine && has(s.name));
    if (others.length && !this.archived) {
      rows.push({ key: "o:head", kind: "other-head" });
      for (const s of others) rows.push({ key: `o:${s.id}`, kind: "space", depth: 0, space: s, status: s.status, item: { kind: "space", space: s.id } });
    }
    // What the sessions under each row do, for the row to show while folded.
    const cutoff = Date.now() / 1000 - HOT_SECONDS;
    const activity = {};
    for (const r of rows) {
      if (r.kind !== "session" && r.kind !== "adhoc") continue;
      r.hot = (this.stats.sessions[r.item.session.cm_name]?.last_active ?? 0) > cutoff;
      for (const key of r.parents) {
        const a = (activity[key] ??= { working: 0, blocked: 0, done: 0, hot: false });
        if (r.status === "working" || r.status === "blocked" || r.status === "done") a[r.status] += 1;
        a.hot ||= r.hot;
      }
    }
    for (const r of rows) if (activity[r.key]) r.activity = activity[r.key];
    this.allRows = rows;
    return rows.filter((r) => !(r.parents ?? []).some((k) => !open(k)));
  }

  // Herdr names the spaces and tabs showrunner's labels made after their
  // folders and places: give them the task's and session's names instead.
  syncNames() {
    // Forget what went away: a session started again gets its name again.
    const present = new Set(spaces().flatMap((s) => [s.id, ...(s.tabs ?? []).map((t) => t.id)]));
    for (const id of this.renamed) if (!present.has(id)) this.renamed.delete(id);
    for (const s of spaces()) {
      if (s.machine) continue;
      const want = this.names?.[s.id];
      if (want && !s.named && !this.renamed.has(s.id)) {
        this.renamed.add(s.id);
        run("space.rename", { id: s.id, name: want });
      }
      for (const tab of s.tabs ?? []) {
        const name = this.names?.[tab.id];
        if (name && !tab.named && !this.renamed.has(tab.id)) {
          this.renamed.add(tab.id);
          run("tab.rename", { id: tab.id, name });
        }
      }
    }
  }

  // Spaces and tabs in the tree's order, so Herdr's space and tab keys walk
  // tasks and sessions as listed. Once things settle, a move at a time.
  syncOrder() {
    const now = Date.now();
    if (this.ordering && now - this.ordering < 1500) return;
    const sp = spaces().filter((s) => !s.machine);
    const move = (command, ids, wanted) => {
      const mine = ids.filter((id) => wanted.includes(id));
      const want = wanted.filter((id) => ids.includes(id));
      const i = want.findIndex((id, n) => mine[n] !== id);
      if (i < 0) return false;
      // Its place among them all: where the one in its spot is now.
      this.ordering = now;
      run(command, { id: want[i], index: ids.indexOf(mine[i]) + 1 });
      return true;
    };
    if (move("space.move", sp.map((s) => s.id), this.spaceOrder)) return;
    for (const s of sp) if (move("tab.move", (s.tabs ?? []).map((t) => t.id), this.tabOrder)) return;
  }

  // A tab asked for (a session or run just started) appears: show it.
  revealPending() {
    const want = shared("showrunner.reveal");
    if (!want) return;
    if (Date.now() > want.until) return setShared("showrunner.reveal", null);
    const space = spaces().find((s) => s.id === want.space);
    const tab = space?.tabs?.find((t) => t.id === want.tab);
    if (!tab) return;
    setShared("showrunner.reveal", null);
    const runs = liveRuns(), live = liveSessions();
    const address = live[want.tab]?.address ?? runs[want.tab]?.address;
    const keep = this.handle.is_focused();
    show(want.space, want.tab, address, want.focus);
    // Showing a tab moves the keyboard to it; like the TUI, stay in the list.
    if (!want.focus && keep) this.handle.focus();
    if (!this.allRows?.some((r) => r.key === `s:${want.tab}`)) return false;
    this.expandTo(`s:${want.tab}`);
    this.select(`s:${want.tab}`);
    return true;
  }

  // While the keyboard is elsewhere, the selection follows the shown tab.
  follow(rows, treeFocused) {
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((t) => t.active)?.id ?? null;
    if (tab === this.lastTab) return;
    const first = this.lastTab === undefined;
    this.lastTab = tab;
    // On start, the selection remembered from last time stays.
    if (first && rows.some((r) => r.key === this.sel)) return;
    if (treeFocused || !tab) return;
    // The tab's row, or the closest row above it that isn't folded away.
    const all = this.allRows ?? rows;
    const target = all.find((r) => r.key === `s:${tab}`)
      ?? all.find((r) => (r.kind === "task" || r.kind === "adhoc-group") && r.item.space === space?.id)
      ?? all.find((r) => r.key === `o:${space?.id}`);
    const key = [target?.key, ...[...(target?.parents ?? [])].reverse()].find((k) => rows.some((r) => r.key === k));
    if (key) this.sel = key;
  }

  move(rows, by) {
    const pickable = rows.filter((r) => r.item);
    if (!pickable.length) return;
    const i = pickable.findIndex((r) => r.key === this.sel);
    const next = i < 0 ? 0 : Math.max(0, Math.min(pickable.length - 1, i + by));
    this.select(pickable[next].key);
  }

  select(key) {
    this.sel = key;
    localStorage.setItem("selected", key);
  }

  // Enter: open what the row stands for, like attaching in the TUI.
  activate(row) {
    const { item } = row;
    switch (row.kind) {
      case "adhoc-group":
        if (!row.count) return perform("new-adhoc", item);
        return this.toggle(row.key);
      case "project":
      case "group":
        return this.toggle(row.key);
      case "task":
        if (item.main) return show(item.space, item.main.cm_name, item.main.address, true);
        return perform("show", item);
      case "session":
      case "adhoc":
        return show(item.space, item.session.cm_name, item.session.address, true);
      case "stopped":
        return perform("resume", item);
      case "space":
        return run("space.select", { id: item.space });
    }
  }

  // A click shows a session (or a task's main one) without taking the keyboard.
  preview(row) {
    const { item } = row;
    if (row.kind === "session" || row.kind === "adhoc") show(item.space, item.session.cm_name, item.session.address, false);
    else if (row.kind === "task" && item.main) show(item.space, item.main.cm_name, item.main.address, false);
    else if (row.kind === "space") run("space.select", { id: item.space });
  }

  menu(row, at) {
    if (!row?.item || row.kind === "space") return;
    const item = { ...row.item, groups: this.groupsOf(row.item.project?.name) };
    if (!menuItems(item).length) return;
    openMenu(item, at ?? this.anchor(row));
  }

  groupsOf(project) {
    const p = this.data?.projects?.find((x) => x.name === project);
    return [...new Set((p?.tasks ?? []).map((t) => t.group).filter(Boolean))].sort();
  }

  // Beside the selected row, for a menu opened from the keyboard.
  anchor(row) {
    const zoom = settings().zoom ?? 1;
    const width = find(layout(), "sidebar")?.size?.px ?? 300;
    const y = blockTop() + HEADER + (this.filtering ? 44 : 0) + (this.tops?.[row.key] ?? 0) - this.scroll;
    return { x: Math.round((width - 12) * zoom), y: Math.round(y * zoom) };
  }

  // Move a project, group or task up or down, as K / J do.
  reorder(row, up) {
    const dir = up ? "up" : "down";
    const { project, task, group } = row.item ?? {};
    let args;
    if (row.kind === "project") args = ["project", "move", project.name, dir];
    else if (row.kind === "group") args = ["group", "move", project.name, group, dir, ...(this.archived ? ["--archived"] : [])];
    else if (row.kind === "task") args = ["task", "move", project.name, task.name, dir];
    else return;
    sr(args).then(() => run("showrunner.refresh"));
  }

  cycleTheme() {
    const names = themes().map((t) => t.name);
    const current = settings().theme;
    const name = names[(names.indexOf(current) + 1) % names.length];
    if (name) run("app.theme", { name });
  }

  key(e, cx, rows) {
    const m = e.modifiers;
    if (m.platform || m.control || m.alt) return false;
    // Named keys by name ("enter" types a "\r"), printable ones as typed ("J").
    const k = e.key.length === 1 ? e.key_char ?? e.key : e.key;
    const row = rows.find((r) => r.key === this.sel);
    switch (k) {
      case "j": case "down": this.move(rows, 1); break;
      case "k": case "up": this.move(rows, -1); break;
      case "enter": if (row) this.activate(row); break;
      case " ": case "space":
        if (row && ["project", "group", "task", "adhoc-group"].includes(row.kind)) this.toggle(row.key);
        break;
      case "a": this.menu(row); break;
      case "p": form("project", { kind: "global" }); break;
      case "/":
        this.filtering = true;
        this.input.focus();
        break;
      case "Z":
        this.archived = !this.archived;
        this.scroll = 0;
        break;
      case "K": if (row) this.reorder(row, true); break;
      case "J": if (row) this.reorder(row, false); break;
      case "t": this.cycleTheme(); break;
      case "i": togglePanel("ideas"); break;
      case "q": case "escape":
        if (this.filtering) { this.closeFilter(); break; }
        this.leave();
        break;
      default: return false;
    }
    return true;
  }

  closeFilter() {
    this.filtering = false;
    this.filter = "";
    this.input.set_value("");
    this.handle.focus();
  }

  render(cx) {
    const t = theme();
    const live = liveSessions(this.guessed);
    const runs = liveRuns();
    let rows = this.data ? this.build(live) : [];
    const treeFocused = this.handle.is_focused();
    this.trackTurns(live, cx);
    if (this.data) {
      if (this.revealPending()) rows = this.build(live);
      this.follow(rows, treeFocused);
      this.syncNames();
      this.syncOrder();
    }
    this.lastRows = rows;
    if (!rows.some((r) => r.key === this.sel)) this.sel = rows.find((r) => r.item)?.key ?? null;
    const selected = rows.find((r) => r.key === this.sel);
    this.publish(selected, live);
    const activeTab = spaces().find((s) => s.active)?.tabs?.find((x) => x.active)?.id;
    if ((find(layout(), "sidebar")?.size?.px ?? Infinity) < 160) return this.rail(t, this.allRows);

    // Rows at fixed heights; the strip scrolls only as far as keeps the selection in view.
    this.tops = {};
    let y = 0;
    for (const r of rows) { this.tops[r.key] = y; y += H[r.kind] ?? 26; }
    const total = y;
    const height = this.listHeight;
    const maxScroll = Math.max(0, total - height);
    if (selected && this.followSelection !== this.sel) {
      this.followSelection = this.sel;
      const top = this.tops[selected.key], h = H[selected.kind] ?? 26;
      if (top < this.scroll) this.scroll = top;
      if (top + h > this.scroll + height) this.scroll = top + h - height;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));

    const headerButton = (id, name, tip, on, action) =>
      div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(on ? t.accent : t.dim).when(on, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
        .on_click((_e, cx) => { action(); cx.notify(); }).child(icon(name, 14));

    const body = !this.data
      ? [this.message(t, this.error ? "Can't reach showrunner" : "Loading…", this.error)]
      : !rows.length
        ? [this.empty(t)]
        : rows.map((r) => {
          const top = this.tops[r.key], h = H[r.kind] ?? 26;
          if (top + h < this.scroll || top > this.scroll + height) return null;
          return this.row(r, t, { selected: r.key === this.sel, treeFocused, activeTab, runs })
            .absolute().left(0).right(0).top(top - this.scroll).h(h);
        }).filter(Boolean);

    return v_flex()
      .id("showrunner-tree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (this.filtering && e.key === "escape") { this.closeFilter(); cx.stop_propagation(); cx.notify(); return; }
        if (this.filtering && !this.handle.is_focused()) return;
        if (this.key(e, cx, rows)) { cx.stop_propagation(); cx.notify(); }
      })
      .on_mouse_down("left", () => this.handle.focus())
      .size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(HEADER).flex_none().pl(16).pr(8).gap(2).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_1().child(this.archived ? "Archived tasks" : "Showrunner"))
        .child(headerButton("sr-filter", "search", "Filter  /", this.filtering, () => { this.filtering ? this.closeFilter() : (this.filtering = true, this.input.focus()); }))
        .child(headerButton("sr-archived", "archive", this.archived ? "Back to active tasks  Z" : "Archived tasks  Z", this.archived, () => { this.archived = !this.archived; this.scroll = 0; }))
        .child(headerButton("sr-add", "plus", "Add project  p", false, () => form("project", { kind: "global" }))))
      .when(this.filtering, (el) => el.child(
        h_flex().h(32).mx(10).mb(8).px(9).gap(7).flex_none().items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
          .child(icon("search", 13, t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground))))
      .child(div().id("sr-rows").relative().flex_1().min_h(0).mx(8).overflow_hidden()
        .on_size_change((size, cx) => { this.listHeight = size.height / (settings().zoom ?? 1); cx.notify(); })
        .on_scroll_wheel((e, cx) => { this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll)); cx.notify(); })
        .children(body));
  }

  // Jobs popups queued (see lib.js `enqueue`), in order. Old ones (a quit
  // while one waited) are dropped, never run late.
  runJobs(cx) {
    const queue = shared("showrunner.queue") ?? [];
    if (!queue.length) return;
    setShared("showrunner.queue", []);
    for (const job of queue) {
      if (Date.now() - job.at > 30000) continue;
      if (job.kind === "focus") this.handle.focus();
      else if (job.kind === "perform") {
        const row = this.lastRows?.find((r) => r.key === this.sel);
        const at = row ? this.anchor(row) : null;
        cx.spawn(async () => { await perform(job.action, job.item, at); });
      }
      else if (job.kind === "act") cx.spawn(async () => { await runAct(job); });
    }
  }

  // A session that just stopped working may have changed its diff: look again.
  trackTurns(live, cx) {
    let ended = false;
    for (const [name, s] of Object.entries(live)) {
      if (this.lastStatus[name] === "working" && s.status !== "working") ended = true;
      this.lastStatus[name] = s.status;
    }
    if (ended && !this.turnTimer) {
      this.turnTimer = true;
      cx.timer.after(1500, (cx) => { this.turnTimer = false; this.refreshStats(cx); });
    }
  }

  // What the status bar says about the selection.
  publish(row, live) {
    const item = row?.item;
    let summary = null;
    if (item && row.kind !== "space") {
      const crumbs = [item.project?.name, item.task?.name ?? (item.kind === "adhoc" || item.kind === "adhoc-group" ? "adhoc" : null), item.group && !item.task ? item.group : null, item.session?.name].filter(Boolean);
      const stats = item.session ? this.stats.sessions[item.session.cm_name] : null;
      summary = {
        crumbs,
        branch: item.task ? (item.session && item.session.name !== "main" ? stats?.branch ?? null : item.task.branch) : item.kind === "project" ? this.stats.projects[item.project.name]?.branch ?? null : null,
        base: item.task?.base_branch ?? null,
        pr: item.task ? prSummary(item.task.pr) : null,
        linear: item.task?.linear ? linearId(item.task.linear) : null,
        diff: item.session ? stats?.diff ?? null : item.task ? this.stats.tasks[`${item.project.name}/${item.task.name}`]?.diff ?? null : null,
        status: item.session ? live[item.session.cm_name]?.status ?? (item.kind === "stopped" ? "stopped" : null) : null,
        agent: item.session?.agent ?? null,
        inTmux: item.session?.in_tmux ?? false,
        // What the right panel's views follow: a session (a task's main one).
        ref: item.session?.cm_name ?? (item.task ? item.main?.cm_name ?? `${item.space}__main` : null),
        space: item.space ?? null,
        project: item.project?.name ?? null,
        task: item.task?.name ?? null,
        archived: this.archived,
      };
    }
    const text = JSON.stringify(summary);
    if (text !== this.published) {
      this.published = text;
      setShared("showrunner.selected", summary);
    }
  }

  // The folded sidebar: a cell per task (and adhoc space), its project's color
  // and initial, its most urgent status in the corner. Click shows it.
  rail(t, rows) {
    const cells = rows.filter((r) => r.kind === "task" || (r.kind === "adhoc-group" && r.count > 0));
    return v_flex().id("showrunner-rail").size_full().min_h(0).bg(t.chrome).pt(8).gap(4).items_center().overflow_y_scrollbar()
      .children(cells.map((r) => {
        const on = this.activeSpace(r.item.space);
        const name = r.item.task?.name ?? "adhoc";
        return h_flex().id(`sr-rail-${r.key}`).relative().size(32).flex_none().rounded(7).items_center().justify_center()
          .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .tooltip(`${r.item.project.name} · ${name}`)
          .on_click(() => this.activate(r))
          .child(h_flex().size(20).rounded(5).bg(avatarColor(r.item.project.name)).items_center().justify_center()
            .text_size(11).font_bold().text_color("#ffffff").child([...name][0]?.toUpperCase() ?? "?"))
          .when(Boolean(r.status) && r.status !== "idle", (el) => el.child(div().absolute().right(1).bottom(1).size(9).rounded(5)
            .border_2().border_color(t.chrome).bg(t[r.status] ?? t.dim)));
      }));
  }

  message(t, title, detail) {
    return v_flex().px(10).pt(8).gap(4)
      .child(div().text_color(t.muted).child(title))
      .when(Boolean(detail), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(detail)));
  }

  empty(t) {
    if (this.filter) return this.message(t, "Nothing matches", "Esc clears the filter.");
    if (this.archived) return this.message(t, "No archived tasks", "Z goes back to the active ones.");
    return v_flex().px(10).pt(8).gap(10)
      .child(div().text_color(t.muted).child("No projects yet"))
      .child(h_flex().id("sr-empty-add").h(30).px(10).gap(7).items_center().rounded(8).border_1().border_color(t.input)
        .text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(() => form("project", { kind: "global" }))
        .child(icon("folder-plus", 14)).child("Add a project").child(div().flex_1()).child(div().text_size(11).text_color(t.dim).child("p")));
  }

  row(r, t, { selected, treeFocused, activeTab, runs }) {
    const indent = 6 + r.depth * 12;
    const base = h_flex().id(`sr-${r.key}`).px(6).pl(indent).gap(4).items_center().rounded(7)
      .border_1().border_color(selected && treeFocused ? t.accent : "#00000000")
      .when(selected && treeFocused, (el) => el.bg(t.selected))
      .when(!(selected && treeFocused), (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((e, cx) => {
        this.select(r.key);
        if (e.click_count === 2) this.activate(r);
        else this.preview(r);
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => { this.select(r.key); this.menu(r, "pointer"); cx.notify(); });
    const chevron = (folded) => div().id(`sr-fold-${r.key}`).size(12).flex_none().flex().items_center().justify_center().text_color(t.dim)
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(r.key); cx.notify(); })
      .child(icon(folded ? "chevron-right" : "chevron-down", 11));
    // A folded row shows what its hidden sessions do; an open one leaves it
    // to the rows under it.
    const hidden = r.folded ? r.activity : null;
    const fire = div().flex_none().text_size(11).child("🔥");
    // How many tasks (sessions) a folded group (adhoc) holds, boxed so it
    // doesn't read as a count of what's beside it.
    const countBox = (n, noun) => div().id(`sr-count-${r.key}`).flex_none().px(4).rounded(4).border_1().border_color(t.border)
      .text_size(10).text_color(t.dim).tooltip(`${n} ${noun}${n === 1 ? "" : "s"}`).child(String(n));
    const runMark = (name) => {
      const live = name && runs[name];
      if (!live) return null;
      return live.running
        ? svg("mods/showrunner/icons/spinner.svg").size(11).flex_none().text_color(t.ansi2).spin(1100)
        : icon("play", 10, t.ansi2);
    };

    switch (r.kind) {
      case "project": {
        const { project } = r.item;
        return base.mt(4).pl(4)
          .child(chevron(r.folded))
          .child(avatar(project.name))
          .child(div().id(`sr-name-${r.key}`).flex_shrink(0).max_w(170).truncate().font_semibold().text_color(t.foreground).tooltip(project.name).child(project.name))
          .when(Boolean(hidden?.hot), (el) => el.child(fire))
          .child(div().flex_1())
          .when(Boolean(activityBadge(t, hidden)), (el) => el.child(activityBadge(t, hidden)))
          .when(Boolean(runMark(r.item.run)), (el) => el.child(runMark(r.item.run)))
          .when(Boolean(r.branch) && r.branch !== "main" && r.branch !== "master", (el) =>
            el.child(h_flex().flex_shrink(1).min_w(0).gap(3).items_center().text_size(11).text_color(t.dim)
              .child(icon("git-branch", 11)).child(div().truncate().child(r.branch))));
      }
      case "group":
        return base
          .child(chevron(r.folded))
          .child(icon("layers", 12, t.dim))
          .child(div().flex_shrink(1).min_w(0).truncate().text_size(12).text_color(t.muted).child(r.label))
          .when(Boolean(hidden?.hot), (el) => el.child(fire))
          .child(div().flex_1())
          .when(Boolean(activityBadge(t, hidden)), (el) => el.child(activityBadge(t, hidden)))
          .when(r.folded, (el) => el.child(countBox(r.count, "task")));
      case "task": {
        const { task } = r.item;
        const needs = r.folded && r.status === "blocked";
        const ticket = linearId(task.linear);
        // The task's PR or ticket in the right panel; again hides it.
        const panelIcon = (view, name, color, tip) => div().id(`sr-${view}-${r.key}`).size(18).flex_none().flex().items_center().justify_center()
          .rounded(5).hover((s) => s.bg(t.hover)).tooltip(tip)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            const same = this.sel === r.key;
            this.select(r.key);
            same ? togglePanel(view) : showPanel(view);
            cx.notify();
          })
          .child(icon(name, 13, color));
        return base
          .child(chevron(r.folded))
          .child(statusGlyph(t, r.folded ? r.status : null))
          .child(div().id(`sr-name-${r.key}`).flex_shrink(1).min_w(0).truncate()
            .text_color(needs ? t.blocked : task.archived ? t.muted : t.foreground)
            .when(this.activeSpace(r.item.space), (el) => el.font_semibold())
            .tooltip(task.name)
            .child(task.name))
          .when(Boolean(hidden?.hot), (el) => el.child(fire))
          .when(task.stack?.size > 1, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${task.stack.position}/${task.stack.size}`)))
          .child(div().flex_1())
          .when(Boolean(runMark(r.item.run)), (el) => el.child(runMark(r.item.run)))
          .when(Boolean(ticket), (el) => el.child(panelIcon("ticket", "ticket", t.dim, ticket)))
          .when(Boolean(task.pr), (el) => el.child(panelIcon("pr", "git-pull-request", prColor(t, task.pr), prSummary(task.pr))))
          .when(Boolean(diffBadge(t, r.diff)), (el) => el.child(diffBadge(t, r.diff)));
      }
      case "adhoc-group":
        return base
          .child(r.count ? chevron(r.folded) : div().size(12).flex_none())
          .child(icon("house", 12, t.accent))
          .child(div().text_size(12).text_color(r.count ? t.muted : t.dim).child("adhoc"))
          .when(Boolean(hidden?.hot), (el) => el.child(fire))
          .child(div().flex_1())
          .when(Boolean(activityBadge(t, hidden)), (el) => el.child(activityBadge(t, hidden)))
          .when(r.folded && r.count > 0, (el) => el.child(countBox(r.count, "session")));
      case "session":
      case "adhoc":
      case "stopped": {
        const { session } = r.item;
        const stopped = r.kind === "stopped";
        const isMain = session.name === "main";
        const shown = !stopped && activeTab === session.cm_name;
        const program = programIcon(r.program ?? { icon: `icons/${session.agent}.svg`, tint: false }, 13, t.muted);
        const branchTail = !isMain && r.branch && r.kind === "session" ? r.branch : null;
        return base
          .when(shown, (el) => el.child(div().absolute().left(indent - 8).top(5).bottom(5).w(2).rounded(1).bg(t.accent)))
          .child(statusGlyph(t, r.status))
          .when(Boolean(program), (el) => el.child(program.when(stopped, (p) => p.opacity(0.5))))
          .when(isMain, (el) => el.child(icon("diamond", 9, t.accent)))
          .child(div().flex_shrink(0).max_w(150).truncate()
            .text_color(stopped ? t.dim : r.status === "blocked" ? t.blocked : t.foreground)
            .when(shown, (el) => el.font_semibold())
            .child(session.name))
          .when(Boolean(r.hot), (el) => el.child(fire))
          .when(stopped, (el) => el.child(div().text_size(11).text_color(t.dim).child(session.in_tmux ? "in tmux" : "stopped")))
          .when(Boolean(branchTail), (el) => el.child(div().flex_shrink(1).min_w(0).truncate().text_size(11).text_color(t.dim).child(branchTail)))
          .child(div().flex_1())
          .when(Boolean(runMark(session.run)), (el) => el.child(runMark(session.run)))
          .when(Boolean(diffBadge(t, r.diff)), (el) => el.child(diffBadge(t, r.diff)));
      }
      case "other-head":
        return h_flex().id("sr-other").pl(8).pt(10).items_center().text_size(11.5).text_color(t.dim).child("Other spaces");
      case "space":
        return base.pl(8)
          .child(statusGlyph(t, r.status))
          .child(avatar(r.space.name, 16))
          .child(div().flex_1().truncate().text_color(r.space.active ? t.foreground : t.muted).child(r.space.name));
      default:
        return div();
    }
  }

  activeSpace(id) {
    return spaces().some((s) => s.active && s.id === id);
  }
}
