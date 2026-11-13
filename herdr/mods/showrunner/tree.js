// The sidebar: projects, task groups, tasks and their sessions, as the TUI
// lists them, with the TUI's keys. Statuses are Herdr's live ones; structure,
// diffs and PRs come from `showrunner list`. Each of Herdr's other machines
// that runs showrunner gets a section with its own projects, below this
// machine's (then a section too): its listing's ids carry the machine's name,
// as Herdr's ids for its spaces and tabs do.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, focused, run, theme, settings, shared, setShared, nextCommand, readTextFile, window, layout, themes, openOverlay, machines, notify } from "herdr";
import { sr, act, clean, loadConfig, liveSessions, liveRuns, guessedStatus, worst, menuItems, show, runAct, qualify, bare, machineOf, hcMachines, reconnectMachine } from "./lib.js";
import { perform, openMenu, form } from "./actions.js";
import { togglePanel, showPanel, panelEntries } from "./panels.js";
import { icon, programIcon, statusGlyph, prColor, diffBadge, activityBadge, avatar, avatarColor, linearId, prSummary } from "./ui.js";

const H = { coordinator: 34, machine: 34, project: 34, group: 26, task: 28, session: 26, stopped: 26, "adhoc-group": 26, adhoc: 26, "other-head": 32, space: 28, hint: 30 };
const HOT_SECONDS = 2 * 3600;
const HEADER = 31;
// How long a machine without showrunner is left alone before it's asked again.
const ABSENT_RETRY = 5 * 60 * 1000;

// Another machine's listing with Herdr's names for its sessions, runs and spaces.
function qualifyListing(data, m) {
  const q = (id) => qualify(m, id);
  const session = (s) => ({ ...s, cm_name: q(s.cm_name), run: q(s.run) });
  for (const p of data.projects ?? []) {
    Object.assign(p, { space: q(p.space), run: q(p.run) });
    p.adhoc_sessions = (p.adhoc_sessions ?? []).map(session);
    p.adhoc_stopped = (p.adhoc_stopped ?? []).map(session);
    for (const t of p.tasks ?? []) {
      Object.assign(t, { space: q(t.space), run: q(t.run) });
      t.sessions = (t.sessions ?? []).map(session);
      t.stopped = (t.stopped ?? []).map(session);
    }
  }
  data.coordinator = null;
  return data;
}

// Diffs, branches, PRs and last activity from a `list --stats`, by the tree's keys.
function statsOf(data, m) {
  const stats = { projects: {}, tasks: {}, sessions: {} };
  for (const p of data.projects ?? []) {
    const K = qualify(m, p.name);
    stats.projects[K] = { branch: p.branch };
    const sessions = [...(p.adhoc_sessions ?? [])];
    for (const t of p.tasks ?? []) {
      stats.tasks[`${K}/${t.name}`] = { diff: t.diff, pr: t.pr };
      sessions.push(...(t.sessions ?? []));
    }
    for (const s of sessions) stats.sessions[qualify(m, s.cm_name)] = { diff: s.diff, branch: s.branch, last_active: s.last_active };
  }
  return stats;
}

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
    // Stats by machine ("" for this one), merged into `stats`.
    this.statsBy = {};
    // Other machines: { data, error, absent (when it had no showrunner), restored, ... }.
    this.remote = {};
    // The machines found without showrunner: no section, also while out of
    // reach. Every other one keeps its row then, to reconnect it.
    this.withoutShowrunner = new Set(JSON.parse(localStorage.getItem("machines-without-showrunner") ?? "[]"));
    // hc's word on the machines out of reach ({ state, why, … } by name), and
    // the ones being reconnected.
    this.hcState = {};
    this.reconnecting = new Set();
    this.guessed = {};
    // Folded unless opened: projects, groups, tasks and adhoc start closed.
    this.expanded = new Set(JSON.parse(localStorage.getItem("expanded") ?? "[]"));
    // Machine sections are open unless folded.
    this.foldedMachines = new Set(JSON.parse(localStorage.getItem("folded-machines") ?? "[]"));
    this.archived = false;
    this.filtering = false;
    this.filter = "";
    this.sel = localStorage.getItem("selected");
    // When each tab was last left: the session switcher's "last used".
    this.visited = JSON.parse(localStorage.getItem("visited") ?? "{}");
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
    // From a timer: after a layout switch, work spawned here never finishes.
    cx.timer.after(1, (cx) => cx.spawn(async (cx) => {
      await loadConfig();
      await sr(["restore"]);
      this.refresh(cx);
      this.refreshStats(cx);
    }));
    // Herdr moving the keyboard away (Ctrl-B l) tells the tree nothing: the
    // selection would stay lit and the tree wouldn't follow the tabs.
    cx.timer.every(150, (cx) => {
      const focused = this.handle.is_focused();
      if (focused !== this.wasFocused) { this.wasFocused = focused; cx.notify(); }
    });
    cx.timer.every(1500, (cx) => this.watch(cx));
    cx.timer.every(3000, (cx) => this.watchRemotes(cx));
    cx.timer.every(5000, (cx) => this.refreshHcState(cx));
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
    else if (c === "coordinator") this.openCoordinator();
    else if (c === "switcher") this.openSwitcher();
    else if (c === "collapse") this.collapseAll();
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

  // The Coordinator's terminal gets the keyboard (⌃; from anywhere); it starts
  // first when it isn't running.
  openCoordinator() {
    const c = this.data?.coordinator;
    if (!c) return;
    const live = liveSessions(this.guessed)[c.cm_name];
    this.select(`s:${c.cm_name}`);
    if (live) return show(c.space, c.cm_name, live.address, true);
    act("Starting the coordinator", ["coordinator"],
      { success: "Coordinator started", after: { reveal: { space: c.space, tab: c.cm_name, focus: true } } });
  }

  // The session switcher (⌘K): every running session but the one on screen,
  // those that need you first, then the ones done since you looked, then the
  // most recently used.
  openSwitcher() {
    const live = liveSessions(this.guessed);
    const current = spaces().find((s) => s.active)?.tabs?.find((t) => t.active)?.id;
    const entries = [];
    const add = (parts, space, cm, machine = null) => {
      const l = live[cm];
      if (!l || cm === current) return;
      const at = this.visited[cm] ?? (this.stats.sessions[cm]?.last_active ?? 0) * 1000;
      entries.push({ parts, machine, label: [machine, ...parts].filter(Boolean).join(" - "), space, tab: cm, address: l.address, status: l.status, at });
    };
    const c = this.data?.coordinator;
    if (c) add(["Coordinator"], c.space, c.cm_name);
    for (const { machine: m, data } of this.sources()) {
      for (const p of data?.projects ?? []) {
        for (const s of p.adhoc_sessions ?? []) add([p.name, "adhoc", s.name], p.space, s.cm_name, m);
        for (const t of p.tasks ?? []) for (const s of t.sessions ?? []) add([p.name, t.name, s.name], t.space, s.cm_name, m);
      }
    }
    const rank = (s) => ({ blocked: 0, done: 1 })[s] ?? 2;
    entries.sort((a, b) => rank(a.status) - rank(b.status) || b.at - a.at);
    const back = this.handle.is_focused() ? "tree" : focused()?.pane ?? null;
    openOverlay({ mod: "showrunner", kind: "dialog", width: 600, height: 430, props: { view: "switcher", entries, back } });
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
    this.refreshRemotes(cx);
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
    for (const m of [null, ...Object.keys(this.remote).filter((m) => this.online(m))]) this.refreshStatsOn(cx, m);
  }

  refreshStatsOn(cx, m) {
    const key = m ?? "";
    this.statsLoading ??= {};
    if (this.statsLoading[key]) return;
    this.statsLoading[key] = true;
    cx.spawn(async (cx) => {
      const r = await sr(["list", "--json", "--stats", "--no-status", "--local"], 180000, m);
      this.statsLoading[key] = false;
      if (r.code !== 0) return;
      let data;
      try { data = JSON.parse(r.stdout); } catch { return; }
      this.statsBy[key] = statsOf(data, m);
      const merged = { projects: {}, tasks: {}, sessions: {} };
      for (const st of Object.values(this.statsBy)) for (const k of Object.keys(merged)) Object.assign(merged[k], st[k]);
      this.stats = merged;
      cx.notify();
    });
  }

  // A machine whose showrunner answered and that Herdr reaches now.
  online(m) {
    const st = this.remote[m];
    return Boolean(st?.data) && machines().some((x) => x.name === m && x.layout === "ready");
  }

  // Herdr's other machines: each one's listing, the way this machine's comes.
  // Its saved sessions come back when it first answers, and again after it
  // was out of reach (a reboot), as here on start.
  refreshRemotes(cx) {
    for (const { name: m, layout: state } of machines()) {
      if (!m) continue;
      // Back from a reboot, its sessions come back again.
      if (state !== "ready") { if (this.remote[m]) this.remote[m].restored = false; continue; }
      const st = (this.remote[m] ??= { data: null, error: null });
      if (st.loading || (st.absent && Date.now() - st.absent < ABSENT_RETRY)) continue;
      st.loading = true;
      cx.spawn(async (cx) => {
        if (!st.restored) {
          // Without a Coordinator: the one here oversees.
          const r = await sr(["restore", "--no-coordinator"], 300000, m);
          st.restored = r.code !== 127;
        }
        const r = await sr(["list", "--json", "--no-status", "--local"], undefined, m);
        st.loading = false;
        if (r.code === 0) {
          try { st.data = qualifyListing(JSON.parse(r.stdout), m); st.error = null; st.absent = null; } catch (e) { st.error = `Unreadable listing: ${e}`; }
          if (st.data) this.rememberShowrunner(m, true);
        } else if (r.code === 127) {
          // No showrunner there: no section for it.
          Object.assign(st, { data: null, error: null, absent: Date.now(), restored: false });
          this.rememberShowrunner(m, false);
        } else {
          st.error = clean(r.stderr) || "showrunner did not answer";
        }
        cx.notify();
        if (!st.statsAsked && st.data) { st.statsAsked = true; this.refreshStatsOn(cx, m); }
      });
    }
  }

  rememberShowrunner(m, has) {
    if (this.withoutShowrunner.has(m) === !has) return;
    has ? this.withoutShowrunner.delete(m) : this.withoutShowrunner.add(m);
    localStorage.setItem("machines-without-showrunner", JSON.stringify([...this.withoutShowrunner]));
  }

  // Why hc can't reach a machine, while one is out of reach.
  refreshHcState(cx) {
    if (this.askingHc || !machines().some((x) => x.name && x.layout !== "ready")) {
      if (!this.askingHc && Object.keys(this.hcState).length) { this.hcState = {}; cx.notify(); }
      return;
    }
    this.askingHc = true;
    cx.spawn(async (cx) => {
      const list = await hcMachines();
      this.askingHc = false;
      if (!list) return;
      this.hcState = Object.fromEntries(list.map((x) => [x.name, x]));
      cx.notify();
    });
  }

  // Reconnect a machine out of reach, opening Tailscale's login page in the
  // browser when its SSH asks for one.
  reconnect(m, cx) {
    if (!m || this.reconnecting.has(m)) return;
    this.reconnecting.add(m);
    notify({ title: `Reconnecting to ${m}`, body: "If Tailscale asks for a login, approve it in the browser page that opens.", level: "info", timeout: 8000 });
    cx.notify();
    cx.spawn(async (cx) => {
      const { machine, error } = await reconnectMachine(m);
      this.reconnecting.delete(m);
      if (machine?.state === "connected") {
        notify({ title: `Reconnected to ${m}`, level: "success", timeout: 4000 });
        delete this.hcState[m];
        this.refreshRemotes(cx);
      } else {
        if (machine) this.hcState[m] = machine;
        notify({ title: `Couldn't reconnect to ${m}`, body: error || machine?.why || "hc still can't reach it.", level: "error", timeout: 12000 });
      }
      cx.notify();
    });
  }

  // Other machines' config.toml and sessions.json, as `watch` reads this one's.
  watchRemotes(cx) {
    // A machine Herdr just reached is asked at once.
    if (machines().some((x) => x.name && x.layout === "ready" && !this.remote[x.name])) this.refreshRemotes(cx);
    for (const [m, st] of Object.entries(this.remote)) {
      const dir = st.data?.data_dir;
      if (!dir || st.watching || !this.online(m)) continue;
      st.watching = true;
      cx.spawn(async (cx) => {
        const read = (f) => readTextFile(`${dir}/${f}`, { on: m }).catch(() => null);
        const text = `${await read("config.toml")}\0${await read("sessions.json")}`;
        st.watching = false;
        if (st.seen !== undefined && text !== st.seen) this.refresh(cx);
        st.seen = text;
      });
    }
  }

  // Agents that don't report a status (codex, pi): showrunner reads their screens.
  refreshGuesses(cx) {
    if (this.guessing || !this.data) return;
    // The machines (null: this one) with a session that reports nothing.
    const silent = new Set(Object.entries(liveSessions()).filter(([, s]) => !s.status).map(([name]) => machineOf(name)));
    if (!silent.size) { this.guessed = {}; return; }
    this.guessing = true;
    cx.spawn(async (cx) => {
      const guessed = {};
      for (const m of silent) {
        const r = await sr(["list", "--json", "--local"], undefined, m);
        if (r.code !== 0) continue;
        try {
          for (const p of JSON.parse(r.stdout).projects ?? [])
            for (const s of [...(p.adhoc_sessions ?? []), ...(p.tasks ?? []).flatMap((t) => t.sessions ?? [])])
              guessed[qualify(m, s.cm_name)] = guessedStatus(s.status);
        } catch {}
      }
      this.guessing = false;
      this.guessed = guessed;
      cx.notify();
    });
  }

  toggle(key) {
    const [set, item] = key.startsWith("m:") ? [this.foldedMachines, "folded-machines"] : [this.expanded, "expanded"];
    set.has(key) ? set.delete(key) : set.add(key);
    localStorage.setItem(item, JSON.stringify([...set]));
  }

  isOpen(key) {
    return key.startsWith("m:") ? !this.foldedMachines.has(key) : this.expanded.has(key);
  }

  // Open the rows above a row, so it shows.
  expandTo(key) {
    const row = this.allRows?.find((r) => r.key === key);
    for (const parent of row?.parents ?? []) if (!this.isOpen(parent)) this.toggle(parent);
  }

  // This machine's listing, then those of the other machines Herdr reaches
  // that have showrunner, by name.
  sources() {
    const known = new Set(machines().map((m) => m.name).filter(Boolean));
    // One out of reach keeps its row, to reconnect it, unless it had no showrunner.
    const others = [...known]
      .map((m) => [m, this.remote[m] ?? {}])
      .filter(([m, st]) => st.data || st.error || (!st.absent && !this.withoutShowrunner.has(m)))
      .sort(([a], [b]) => a.localeCompare(b));
    return [{ machine: null, data: this.data }, ...others.map(([m, st]) => ({ machine: m, data: st.data ?? null, error: st.error ?? null }))];
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
    const open = (key) => Boolean(f) || this.isOpen(key);
    const sessionInfo = (s, stopped) => ({
      cm_name: s.cm_name, name: s.name, agent: s.agent, worktree: s.worktree ?? null,
      run: s.run ?? null, live: !stopped && Boolean(live[s.cm_name]), address: live[s.cm_name]?.address ?? null,
      remote_control: s.remote_control ?? false,
      in_tmux: Boolean(stopped && s.in_tmux),
    });
    // The Coordinator, above every project: always the first row.
    const c = this.data?.coordinator;
    if (c && !this.archived && has("Coordinator")) {
      const l = live[c.cm_name];
      this.names[c.space] = this.names[c.cm_name] = "Coordinator";
      this.spaceOrder.push(c.space);
      this.tabOrder.push(c.cm_name);
      rows.push({ key: `s:${c.cm_name}`, kind: "coordinator", depth: 0, status: l ? l.status : "stopped",
        item: { kind: "coordinator", space: c.space, session: { cm_name: c.cm_name, name: "Coordinator", agent: "claude", live: Boolean(l), address: l?.address ?? null } } });
    }
    const sources = this.sources();
    for (const src of sources) {
      const M = src.machine;
      // With other machines, each machine's projects sit under its row
      // (this one's: `m:`).
      let section = [];
      const sectionAt = rows.length;
      if (sources.length > 1) {
        const mkey = `m:${M ?? ""}`;
        const offline = Boolean(M) && !this.online(M);
        const layout = M ? machines().find((x) => x.name === M)?.layout : null;
        const hcState = this.hcState[M];
        // hc gave up on it (not just connecting or loading): Reconnect.
        const lost = offline && (layout === "unavailable" || ["unreachable", "needs_login"].includes(hcState?.state));
        const label = M ?? src.data?.machine_name ?? "This machine";
        rows.push({ key: mkey, kind: "machine", depth: 0, folded: !open(mkey), offline, layout, lost, why: hcState?.why ?? null,
          reconnecting: this.reconnecting.has(M), error: src.error, item: { kind: "machine", machine: M, label } });
        if (offline) continue;
        section = [mkey];
      }
      for (const p of src.data?.projects ?? []) {
        // The project's key: other machines may have one with the same name.
        const K = qualify(M, p.name);
        const P = { name: p.name, path: p.path, run_command: p.run_command, space: p.space, run: p.run, agent: src.data.default_agent ?? "claude", machine: M };
        const pkey = `p:${K}`;
        const projectHit = has(p.name);
        const tasks = (p.tasks ?? []).filter((t) => Boolean(t.archived) === this.archived);
        const projectRows = [];
        let sessionsTotal = 0;
        let lastGroup = null;
        // Adhoc sessions, the project's own space: first, when there are any.
        if (!this.archived) {
          const running = (p.adhoc_sessions ?? []).filter((s) => live[s.cm_name]);
          const stopped = [...(p.adhoc_stopped ?? []), ...(p.adhoc_sessions ?? []).filter((s) => !live[s.cm_name])];
          const hits = [...running.map((s) => [s, false]), ...stopped.map((s) => [s, true])].filter(([s]) => projectHit || has(s.name, "adhoc"));
          this.names[p.space] = p.name;
          this.names[p.run] = "▶ run";
          if (hits.length) this.spaceOrder.push(p.space);
          if (hits.length) {
            const akey = `a:${K}`;
            const status = worst(running.map((s) => live[s.cm_name].status));
            sessionsTotal += running.length;
            projectRows.push({ key: akey, kind: "adhoc-group", depth: 1, parents: [...section, pkey], status, folded: !open(akey), count: hits.length,
              item: { kind: "adhoc-group", project: P, space: p.space, machine: M } });
            for (const [s, isStopped] of hits) {
              this.names[s.cm_name] = s.name;
              this.tabOrder.push(s.cm_name);
              projectRows.push({
                key: `s:${s.cm_name}`, kind: isStopped ? "stopped" : "adhoc", depth: 2, parents: [...section, pkey, akey],
                item: { kind: isStopped ? "stopped" : "adhoc", project: P, session: sessionInfo(s, isStopped), space: p.space, run: s.run, machine: M },
                status: isStopped ? "stopped" : live[s.cm_name]?.status, program: live[s.cm_name]?.program,
                diff: this.stats.sessions[s.cm_name]?.diff,
              });
            }
          }
        }
        for (const t of tasks) {
          const T = { name: t.name, branch: t.branch, base_branch: t.base_branch, linear: t.linear, group: t.group, archived: t.archived, pr: this.stats.tasks[`${K}/${t.name}`]?.pr ?? null, stack: t.stack };
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
            const gkey = `g:${K}/${t.group}`;
            const groupTasks = tasks.filter((x) => x.group === t.group);
            projectRows.push({ key: gkey, kind: "group", depth: 1, parents: [...section, pkey], label: t.group, count: groupTasks.length,
              item: { kind: "group", project: P, group: t.group, space: p.space, machine: M }, folded: !open(gkey) });
          }
          lastGroup = t.group ?? null;
          const inGroup = Boolean(t.group);
          const above = inGroup ? [...section, pkey, `g:${K}/${t.group}`] : [...section, pkey];
          const tkey = `t:${K}/${t.name}`;
          const mainInfo = main ? sessionInfo(main, false) : null;
          const taskItem = { kind: "task", project: P, task: T, space, run: t.run, main: mainInfo, counts: { sessions: running.length }, machine: M };
          projectRows.push({ key: tkey, kind: "task", depth: inGroup ? 2 : 1, parents: above, item: taskItem, status, folded: !open(tkey),
            blocked: statuses.filter((s) => s === "blocked").length, diff: this.stats.tasks[`${K}/${t.name}`]?.diff });
          const ordered = [...running.map((s) => [s, false]), ...stopped.map((s) => [s, true])]
            .filter(([s]) => sessionHits.includes(s))
            .sort(([a], [b]) => (a.name !== "main") - (b.name !== "main") || a.name.localeCompare(b.name, undefined, { numeric: true }));
          for (const [s, isStopped] of ordered) {
            this.names[s.cm_name] = s.name === "main" ? "main" : /^\d+$/.test(s.name) ? `session ${s.name}` : s.name;
            this.tabOrder.push(s.cm_name);
            const S = sessionInfo(s, isStopped);
            projectRows.push({
              key: `s:${s.cm_name}`, kind: isStopped ? "stopped" : "session", depth: (inGroup ? 2 : 1) + 1, parents: [...above, tkey],
              item: { kind: isStopped ? "stopped" : "session", project: P, task: T, session: S, space, run: s.run, main: mainInfo, machine: M },
              status: isStopped ? "stopped" : live[s.cm_name]?.status, program: live[s.cm_name]?.program,
              diff: this.stats.sessions[s.cm_name]?.diff, branch: this.stats.sessions[s.cm_name]?.branch,
            });
            if (s.run) this.names[s.run] = "▶ run";
          }
          this.names[t.run] = "▶ run";
        }
        if (!projectHit && !projectRows.length) continue;
        rows.push({ key: pkey, kind: "project", depth: 0, parents: section, folded: !open(pkey), branch: this.stats.projects[K]?.branch,
          item: { kind: "project", project: P, space: p.space, run: p.run, counts: { tasks: (p.tasks ?? []).length, sessions: sessionsTotal }, machine: M } });
        rows.push(...projectRows);
      }
      // A filter matching nothing on a machine leaves out its row too.
      if (section.length && f && rows.length === sectionAt + 1) rows.pop();
    }
    // Herdr spaces that aren't showrunner's (a plain terminal, another agent).
    const others = spaces().filter((s) => !bare(s.machine, s.id).startsWith("cm__") && has(s.name));
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
    // This machine's: moves of another machine's spaces don't hold.
    const sp = spaces().filter((s) => !s.machine);
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
    if (this.lastTab) {
      this.visited[this.lastTab] = Date.now();
      localStorage.setItem("visited", JSON.stringify(this.visited));
    }
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
  activate(row, cx) {
    const { item } = row;
    switch (row.kind) {
      case "coordinator":
        return this.openCoordinator();
      case "adhoc-group":
        return this.toggle(row.key);
      case "machine":
        // Out of reach: Enter reconnects (its section has nothing to open).
        if (row.lost && cx) return this.reconnect(item.machine, cx);
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

  // A click selects a row and shows its session, the keyboard staying here
  // (showing a tab hands it to the terminal, after this returns); a double
  // click opens it.
  click(row, count, cx) {
    this.select(row.key);
    if (count === 2) return this.activate(row, cx);
    this.preview(row);
    this.handle.focus();
    cx.timer.after(50, () => this.handle.focus());
  }

  // Shows a session (or a task's main one).
  preview(row) {
    const { item } = row;
    if (row.kind === "session" || row.kind === "adhoc" || (row.kind === "coordinator" && item.session.live)) show(item.space, item.session.cm_name, item.session.address, false);
    else if (row.kind === "task" && item.main) show(item.space, item.main.cm_name, item.main.address, false);
    else if (row.kind === "space") run("space.select", { id: item.space });
  }

  menu(row, at) {
    if (!row?.item || row.kind === "space" || row.kind === "coordinator") return;
    const item = { ...row.item, groups: this.groupsOf(row.item.project?.name, row.item.machine) };
    if (!menuItems(item).length) return;
    openMenu(item, at ?? this.anchor(row));
  }

  groupsOf(project, machine) {
    const data = machine ? this.remote[machine]?.data : this.data;
    const p = data?.projects?.find((x) => x.name === project);
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
    sr(args, undefined, row.item.machine).then(() => run("showrunner.refresh"));
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
      case "enter": if (row) this.activate(row, cx); break;
      case " ": case "space":
        if (row && ["machine", "project", "group", "task", "adhoc-group"].includes(row.kind)) this.toggle(row.key);
        break;
      case "a": this.menu(row); break;
      // On the selected row's machine.
      case "p": form("project", { kind: "global", machine: row?.item?.machine ?? null }); break;
      case "/":
        this.filtering = true;
        this.input.focus();
        break;
      case "C": this.collapseAll(); break;
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

  // Projects, groups, tasks and adhoc fold; machine sections stay as they
  // are, so the projects show. The selection goes up to its project.
  collapseAll() {
    const row = this.allRows?.find((r) => r.key === this.sel);
    const project = row?.parents?.find((k) => k.startsWith("p:"));
    this.expanded.clear();
    localStorage.setItem("expanded", "[]");
    this.scroll = 0;
    if (project) this.select(project);
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
        .child(headerButton("sr-collapse", "chevrons-down-up", "Collapse all  C", false, () => this.collapseAll()))
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
      const crumbs = [item.kind === "machine" ? item.label : item.machine, item.project?.name, item.task?.name ?? (item.kind === "adhoc" || item.kind === "adhoc-group" ? "adhoc" : null), item.group && !item.task ? item.group : null, item.session?.name].filter(Boolean);
      const stats = item.session ? this.stats.sessions[item.session.cm_name] : null;
      summary = {
        crumbs,
        branch: item.task ? (item.session && item.session.name !== "main" ? stats?.branch ?? null : item.task.branch) : item.kind === "project" ? this.stats.projects[item.project.name]?.branch ?? null : null,
        base: item.task?.base_branch ?? null,
        pr: item.task ? prSummary(item.task.pr) : null,
        linear: item.task?.linear ? linearId(item.task.linear) : null,
        linearUrl: item.task?.linear ?? null,
        diff: item.session ? stats?.diff ?? null : item.task ? this.stats.tasks[`${item.project.name}/${item.task.name}`]?.diff ?? null : null,
        status: item.session ? live[item.session.cm_name]?.status ?? (item.kind === "stopped" ? "stopped" : null) : null,
        agent: item.session?.agent ?? null,
        inTmux: item.session?.in_tmux ?? false,
        // What the right panel's views follow: a session (a task's main one).
        ref: item.kind === "coordinator" ? null : item.session?.cm_name ?? (item.task ? item.main?.cm_name ?? `${item.space}__main` : null),
        // The session whose Claude the Activity panel follows: the Coordinator's too.
        conversation: item.session?.cm_name ?? (item.task ? item.main?.cm_name ?? `${item.space}__main` : null),
        space: item.space ?? null,
        // Where the right panel's commands run (null: here).
        machine: item.machine ?? null,
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
    const cells = rows.filter((r) => r.kind === "coordinator" || r.kind === "task" || (r.kind === "adhoc-group" && r.count > 0));
    return v_flex().id("showrunner-rail").size_full().min_h(0).bg(t.chrome).pt(8).gap(4).items_center().overflow_y_scrollbar()
      .children(cells.map((r) => {
        const on = this.activeSpace(r.item.space);
        const coordinator = r.kind === "coordinator";
        const name = r.item.task?.name ?? "adhoc";
        return h_flex().id(`sr-rail-${r.key}`).relative().size(32).flex_none().rounded(7).items_center().justify_center()
          .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .tooltip(coordinator ? "Coordinator" : `${r.item.project.name} · ${name}`)
          .on_click((_e, cx) => this.activate(r, cx))
          .child(coordinator ? this.coordinatorMark(t, 20)
            : h_flex().size(20).rounded(5).bg(avatarColor(r.item.project.name)).items_center().justify_center()
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
      .on_click((e, cx) => { this.click(r, e.click_count, cx); cx.notify(); })
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
      case "coordinator": {
        const stopped = r.status === "stopped";
        return base.mt(4).pl(4)
          .child(div().size(12).flex_none())
          .child(this.coordinatorMark(t, 18))
          .child(div().font_semibold().text_color(stopped ? t.muted : t.foreground)
            .when(this.activeSpace(r.item.space), (el) => el.text_color(t.accent))
            .child("Coordinator"))
          .child(div().flex_1())
          .when(stopped, (el) => el.child(div().text_size(11).text_color(t.dim).child("stopped")))
          .when(!stopped, (el) => el.child(statusGlyph(t, r.status)));
      }
      case "machine": {
        const note = r.reconnecting ? "reconnecting…" : r.lost ? "offline" : r.error ? "showrunner failed"
          : r.offline ? (r.layout === "ready" ? "loading…" : "connecting…") : null;
        const tip = r.lost ? r.why : r.error;
        const reconnect = div().id(`sr-reconnect-${r.key}`).flex_none().px(5).rounded(4).border_1().border_color(t.border)
          .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Connect again. If Tailscale asks for a login, its page opens in the browser.")
          .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(r.item.machine, cx); cx.notify(); })
          .child("Reconnect");
        return base.mt(10).pl(4)
          .child(r.offline ? div().size(12).flex_none() : chevron(r.folded))
          .child(icon(r.item.machine ? "server" : "laptop", 13, t.muted))
          .child(div().text_size(12).font_semibold().text_color(r.offline ? t.dim : t.muted).child(r.item.label))
          .when(Boolean(hidden?.hot), (el) => el.child(fire))
          .child(div().flex_1())
          .when(r.reconnecting, (el) => el.child(svg("mods/showrunner/icons/spinner.svg").size(11).flex_none().text_color(t.muted).spin(1100)))
          .when(Boolean(note), (el) => el.child(div().id(`sr-note-${r.key}`).text_size(11).text_color(t.dim).when(Boolean(tip), (x) => x.tooltip(tip)).child(note)))
          .when(r.lost && !r.reconnecting, (el) => el.child(reconnect))
          .when(!note && Boolean(activityBadge(t, hidden)), (el) => el.child(activityBadge(t, hidden)));
      }
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
          .child(chevron(r.folded))
          .child(icon("house", 12, t.accent))
          .child(div().text_size(12).text_color(t.muted).child("adhoc"))
          .when(Boolean(hidden?.hot), (el) => el.child(fire))
          .child(div().flex_1())
          .when(Boolean(activityBadge(t, hidden)), (el) => el.child(activityBadge(t, hidden)))
          .when(r.folded, (el) => el.child(countBox(r.count, "session")));
      case "session":
      case "adhoc":
      case "stopped": {
        const { session } = r.item;
        const stopped = r.kind === "stopped";
        const isMain = Boolean(r.item.task) && session.name === "main";
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

  coordinatorMark(t, size) {
    return h_flex().size(size).flex_none().rounded(5).bg("#8b5cf6").items_center().justify_center()
      .child(icon("compass", Math.round(size * 0.72), "#ffffff"));
  }

  activeSpace(id) {
    return spaces().some((s) => s.active && s.id === id);
  }
}
