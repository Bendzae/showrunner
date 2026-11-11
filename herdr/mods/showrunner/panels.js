// The right panel's showrunner views, following the tree's selection: the
// task's Linear ticket, its PR (checks, open review comments to hand to the
// agent) and its idea queue. They look like Herdr's Files and Changes, and
// their buttons sit beside Files and Changes in the top bar.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { shared, theme, layout, notify, run, nextCommand, settings } from "herdr";
import { sr, clean, openUrl, reveal, liveSessions } from "./lib.js";
import { ICON, keycap } from "./ui.js";

export const PANELS = [
  { id: "files", label: "Files", key: "f", icon: "mods/files/file.svg" },
  { id: "changes", label: "Changes", key: "c", icon: "mods/changes/changes.svg" },
  { id: "ideas", label: "Ideas", key: "i", icon: ICON("lightbulb") },
  { id: "pr", label: "PR", key: "p", icon: ICON("git-pull-request") },
  { id: "ticket", label: "Ticket", key: "t", icon: ICON("ticket") },
  { id: "activity", label: "Activity", key: "a", icon: ICON("activity") },
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export function shownPanel() {
  const panel = find(layout(), "panel");
  return panel && !panel.hidden ? find(layout(), "panel-body")?.active ?? null : null;
}

// Hidden views don't poll.
const visible = (view) => shownPanel() === view;

export function showPanel(view) {
  run("layout.select", { stack: "panel-body", child: view });
  run("layout.show", { id: "panel" });
}

// The command that puts the keyboard on a panel, for those that take it: our
// views, and herdr-reviewer in the Changes panel's place.
export function panelFocus(view) {
  return { showrunner: "showrunner.focus-panel", reviewer: "reviewer.focus" }[find(layout(), view)?.content?.mod] ?? null;
}

export function togglePanel(view) {
  if (visible(view)) run("layout.hide", { id: "panel" });
  else showPanel(view);
}

// The panel switcher's entries, for the menu popup.
export function panelEntries() {
  const shown = shownPanel();
  const entries = PANELS.map((p) => ({ key: p.key, label: p.id === "pr" ? "Pull request" : p.label, icon: p.icon, action: `panel:${p.id}`, on: p.id === shown }));
  return shown ? [...entries, { key: "h", label: "Hide the panel", action: "panel:" }] : entries;
}

// The showrunner panels' buttons, in the tab bar's Files/Changes style.
export class PanelBar {
  init() {}

  render() {
    const t = theme();
    const sel = selection();
    const shown = shownPanel();
    const usable = { ideas: Boolean(sel?.ref), pr: Boolean(sel?.task), ticket: Boolean(sel?.linear), activity: Boolean(sel?.conversation) };
    const stop = (_e, cx) => cx.stop_propagation();
    // The tab bar's right padding is the gap before the first button.
    return h_flex().size_full().gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .children(PANELS.filter((p) => p.id in usable).map((p, i) => {
        const on = shown === p.id;
        return h_flex().id(`panel-${p.id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6).when(i === 0, (el) => el.ml(-7))
          .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : usable[p.id] ? t.muted : t.dim)
          .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
          .on_click(() => togglePanel(p.id))
          .child(svg(p.icon).size(14)).child(p.label);
      }));
  }
}

const selection = () => shared("showrunner.selected");

const headButton = (t, id, label, onClick) => h_flex().id(id).h(24).px(7).flex_none().items_center().rounded(6)
  .text_size(11.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(label);

function button(t, id, label, onClick, primary = true) {
  return div().id(id).h(32).px(14).flex().flex_none().items_center().rounded(8).text_size(12)
    .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.dim)
    .cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
}

const linkStyle = (t, id, text, url) => div().id(id).text_color(t.accent).cursor_pointer()
  .hover((s) => s.underline()).on_click(() => url && openUrl(url)).child(text);

const note = (t, text) => div().p(8).text_size(12).text_color(t.dim).child(text);

const heading = (t, text) => div().px(8).pt(12).pb(4).text_size(11).font_semibold().text_color(t.dim).child(text);

const card = (id) => v_flex().id(id).p(8).gap(4).rounded(7);

function pill(text, bg, fg) {
  return h_flex().h(20).px(7).flex_none().rounded(5).items_center().bg(bg).text_size(11.5).font_semibold().text_color(fg).child(text);
}

// A review comment's text without bot footers, badges and HTML.
function firstParagraph(body) {
  return (body ?? "").split(/\n\s*\n/).filter((part) => !/^\s*(\[!\[|<|!\[)/.test(part)).slice(0, 2).join("\n\n").trim();
}

const zoom = () => settings().zoom ?? 1;

// A body that scrolls itself, so the keyboard can scroll it and keep a
// selected item in view (gpui scrolls only virtual lists from code).
class Scroller {
  // `sticky`: kept at its end as what's in it grows, while it's scrolled there.
  constructor(id, sticky = false) {
    this.id = id;
    this.y = 0;
    this.view = 0;
    this.heights = [];
    this.sticky = sticky;
    this.stuck = sticky;
  }

  content() { return this.heights.reduce((a, b) => a + (b ?? 0), 12); }
  max() { return Math.max(0, this.content() - this.view); }
  by(dy) { this.y = Math.max(0, Math.min(this.y + dy, this.max())); }
  // After the person scrolled: a sticky list follows its end again once back there.
  track() { this.stuck = this.sticky && this.y >= this.max() - 4; }
  reset() { this.y = 0; this.stuck = this.sticky; }

  reveal(i) {
    const top = 6 + this.heights.slice(0, i).reduce((a, b) => a + (b ?? 0), 0), h = this.heights[i] ?? 0;
    if (top < this.y) this.y = top - 6;
    else if (top + h > this.y + this.view) this.y = top + h + 6 - this.view;
    this.by(0);
  }

  render(t, items) {
    this.heights.length = items.length;
    if (this.stuck) this.y = this.max();
    this.by(0);
    const thumb = this.max() > 0 ? Math.max(24, this.view * this.view / this.content()) : 0;
    return div().id(this.id).flex_1().min_h(0).relative().overflow_hidden()
      .on_size_change((size, cx) => { this.view = size.height / zoom(); cx.notify(); })
      .on_scroll_wheel((e, cx) => { this.by(-e.delta.y); this.track(); cx.notify(); })
      .child(v_flex().absolute().left(0).right(0).top(-this.y).p(6).children(items))
      .when(thumb > 0, (el) => el.child(div().absolute().right(2).w(4).rounded(2).bg(t.border)
        .top((this.view - thumb) * this.y / this.max()).h(thumb)));
  }

  measured(i, el) {
    return v_flex().id(`${this.id}-${i}`).flex_none().rounded(7).child(el)
      .on_size_change((size, cx) => {
        const h = size.height / zoom();
        if (this.heights[i] !== h) { this.heights[i] = h; cx.notify(); }
      });
  }
}

// What a panel shows: an element, and what Enter does on it when it can be
// selected.
const item = (el, pick) => ({ el, pick });

// Loads a view's data for the selection's task; again when it changes, and
// every `every` ms while the view is shown. Takes the keyboard when
// `pane.go` (Ctrl-B h/l) moves onto it: j/k move (or scroll), Enter picks,
// h or Esc goes back.
class Loading {
  init(cx, view, every, sticky = false) {
    this.view = view;
    this.state = { status: "idle" };
    this.loaded = null;
    this.handle = cx.focus_handle();
    this.scroller = new Scroller(`${view}-body`, sticky);
    this.pos = 0;
    cx.timer.every(1000, (cx) => {
      const sel = selection();
      const key = this.key(sel);
      if (!visible(view)) return;
      if (key !== this.loaded || (key && Date.now() - (this.loadedAt ?? 0) > every)) this.load(cx, sel, key);
    });
    // Herdr moving the keyboard away (Ctrl-B h) tells the panel nothing: its
    // border would stay lit.
    cx.timer.every(150, (cx) => {
      const focused = this.handle.is_focused();
      if (focused !== this.wasFocused) { this.wasFocused = focused; cx.notify(); }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus" || (c === "focus-panel" && visible(this.view))) this.handle.focus();
        cx.notify();
      }
    });
  }

  load(cx, sel, key) {
    this.loaded = key;
    this.loadedAt = Date.now();
    if (!key) { this.state = { status: "idle" }; return cx.notify(); }
    if (this.state.status !== "ready" || this.state.key !== key) { this.state = { status: "loading" }; this.pos = 0; this.scroller.reset(); }
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.fetch(sel);
      if (this.loaded !== key) return;
      if (r.code === 0) {
        try { this.state = { status: "ready", key, value: this.parse(r.stdout) }; } catch (e) { this.state = { status: "error", message: String(e) }; }
      } else {
        this.state = { status: "error", message: clean(r.stderr) || "showrunner did not answer" };
      }
      cx.notify();
    });
  }

  reload(cx) {
    this.loaded = null;
    const sel = selection();
    this.load(cx, sel, this.key(sel));
  }

  parse(text) {
    return JSON.parse(text);
  }

  // The panel's own keys beyond the shared ones: { key: [hint, action(cx)] }.
  keys() { return {}; }

  // Into a field: the keyboard goes back to the panel on Esc.
  typing() { return false; }

  picks() { return (this.items ?? []).map((x, i) => (x.pick ? i : -1)).filter((i) => i >= 0); }

  move(by) {
    const picks = this.picks();
    if (!picks.length) return this.scroller.by(by * 48);
    this.pos = Math.max(0, Math.min(this.pos + by, picks.length - 1));
    this.scroller.reveal(picks[this.pos]);
  }

  onKey(e, cx) {
    if (!this.handle.is_focused()) {
      if (e.key !== "escape") return;
      this.escape?.();
      this.handle.focus();
    } else if (e.modifiers.control && (e.key === "d" || e.key === "u")) {
      this.scroller.by((e.key === "d" ? 1 : -1) * this.scroller.view / 2);
    } else if (e.modifiers.platform || e.modifiers.control || e.modifiers.alt) {
      return;
    } else {
      const k = e.key.length === 1 ? e.key_char ?? e.key : e.key;
      const picks = this.picks();
      switch (k) {
        case "j": case "down": this.move(1); break;
        case "k": case "up": this.move(-1); break;
        case "g": this.move(-Infinity); this.scroller.y = 0; break;
        case "G": this.move(Infinity); this.scroller.y = this.scroller.max(); break;
        case "enter": this.items?.[picks[this.pos]]?.pick?.(cx); break;
        case "r": this.reload(cx); break;
        case "h": case "escape": run("pane.go", { direction: "left" }); break;
        default: {
          const own = this.keys()[k];
          if (!own) return;
          own[1](cx);
        }
      }
    }
    this.scroller.track();
    cx.stop_propagation();
    cx.notify();
  }

  // Laid out like Herdr's Files and Changes: a card with a header (title, a
  // badge, a dim subtitle on the right), a body and an action bar; with the
  // keyboard, a line of its keys.
  frame(t, head, items, footer) {
    this.items = items;
    const focused = this.handle.is_focused();
    const picks = this.picks();
    this.pos = Math.max(0, Math.min(this.pos, picks.length - 1));
    const selected = focused && picks.length ? picks[this.pos] : -1;
    const hints = [
      [picks.length ? "j/k" : "j/k ⌃d/u", picks.length ? "move" : "scroll"],
      ...(picks.length && this.pickLabel ? [["↵", this.pickLabel]] : []),
      ...Object.entries(this.keys()).filter(([, v]) => v[0]).map(([k, v]) => [k, v[0]]),
      ["r", "refresh"],
      ["h", "back"],
    ];
    return v_flex().id(this.view).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1()
      .border_color(focused || this.typing() ? t.accent : t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child(head.title))
        .when(Boolean(head.badge), (el) => el.child(div().px(5).py(1).flex_none().rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(head.badge)))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(head.subtitle ?? ""))
        .children(head.actions ?? []))
      .child(this.scroller.render(t, items.map((x, i) => this.scroller.measured(i, x.el).when(i === selected, (el) => el.bg(t.selected)))))
      .when(focused, (el) => el.child(h_flex().flex_none().flex_wrap().px(14).py(6).gap_x(12).gap_y(4).border_t(1).border_color(t.border)
        .text_size(11).text_color(t.dim)
        .children(hints.map(([k, label]) => h_flex().gap(4).items_center().child(keycap(t, k)).child(label)))))
      .when(Boolean(footer), (el) => el.child(h_flex().flex_none().p(10).gap(8).items_center().border_t(1).border_color(t.border).children(footer)));
  }
}

export class PrPanel extends Loading {
  init(cx) { super.init(cx, "pr", 60000); }
  key(sel) { return sel?.ref && sel.task ? `${sel.ref}` : null; }
  fetch(sel) { return sr(["session", "pr", sel.ref], 60000, sel.machine); }

  get pickLabel() { return "open"; }

  keys() {
    const p = this.state.status === "ready" ? this.state.value : null;
    return {
      ...(p?.threads.length ? { s: ["send comments to the agent", () => this.sendThreads(selection(), p)] } : {}),
      ...(p ? { o: ["GitHub", () => openUrl(p.url)] } : {}),
    };
  }

  sendThreads(sel, pr) {
    const text = pr.threads.map((x) => `- ${x.path}${x.line ? `:${x.line}` : ""} (${x.author ?? "reviewer"}): ${firstParagraph(x.body)}`).join("\n");
    sr(["send", sel.ref, `Address these unresolved review comments on the PR:\n${text}\n`, "--no-submit"], undefined, sel.machine).then((r) => {
      if (r.code !== 0) return notify({ title: "Couldn't send the comments", body: clean(r.stderr), level: "error" });
      notify({ title: "Review comments in the prompt", body: "Edit them if you like, then press Enter.", level: "success", timeout: 4000 });
      reveal(sel.space, sel.ref, true);
    });
  }

  render() {
    const t = theme();
    const sel = selection();
    const s = this.state;
    const refresh = headButton(t, "pr-refresh", "↻", (_e, cx) => this.reload(cx));
    if (!sel?.task) return this.frame(t, { title: "Pull request" }, [item(note(t, "Select a task or one of its sessions."))]);
    if (s.status === "loading" || s.status === "idle") return this.frame(t, { title: "Pull request", subtitle: sel.task, actions: [refresh] }, [item(note(t, "Loading the pull request…"))]);
    if (s.status === "error") return this.frame(t, { title: "Pull request", subtitle: sel.task, actions: [refresh] }, [item(note(t, s.message))], [
      div().flex_1(),
      button(t, "pr-create", "Push and open a draft PR", () => {
        sr(["task", "pr", sel.project, sel.task, "--create"], 300000, sel.machine).then((r) =>
          r.code === 0 ? (notify({ title: "Draft PR opened", body: r.stdout.trim(), level: "success" }), this.loaded = null)
            : notify({ title: "Couldn't open a PR", body: clean(r.stderr), level: "error" }));
      }),
    ]);
    const p = s.value;
    const count = (state) => p.checks.filter((c) => c.state === state).length;
    const attention = p.checks.filter((c) => c.state === "fail" || c.state === "pending");
    const stateColor = { merged: t.ansi5, closed: t.ansi1, draft: t.muted }[p.state] ?? (count("fail") ? t.ansi1 : count("pending") ? t.ansi3 : t.ansi2);
    const review = { APPROVED: ["✓ approved", t.ansi2], CHANGES_REQUESTED: ["✗ changes requested", t.ansi1] }[p.review] ?? (p.review ? ["◷ review required", t.ansi3] : null);
    const threads = p.threads.length;
    const head = { title: "Pull request", badge: `#${p.number}`, subtitle: sel.task, actions: [headButton(t, "pr-open", "GitHub ↗", () => openUrl(p.url)), refresh] };
    const items = [
      item(v_flex().p(8).gap(8)
        .child(h_flex().gap(8).flex_wrap().items_center()
          .child(pill(p.state, stateColor, t.background))
          .when(Boolean(review), (el) => el.child(div().text_size(12).text_color(review[1]).child(review[0])))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.ansi2).child(`+${p.additions}`))
          .child(div().text_size(11).text_color(t.ansi1).child(`−${p.deletions}`))
          .child(div().text_size(11).text_color(t.dim).child(`${p.changed_files} files`)))
        .child(div().text_size(14).font_semibold().child(p.title))
        .child(h_flex().gap(10).flex_wrap().text_size(12)
          .child(div().text_color(t.ansi2).child(`✓ ${count("pass")} passed`))
          .when(count("fail") > 0, (el) => el.child(div().text_color(t.ansi1).child(`✗ ${count("fail")} failed`)))
          .when(count("pending") > 0, (el) => el.child(div().text_color(t.ansi3).child(`◷ ${count("pending")} pending`)))
          .when(count("skipped") > 0, (el) => el.child(div().text_color(t.dim).child(`⤼ ${count("skipped")} skipped`))))),
      ...(attention.length ? [item(heading(t, "Checks"))] : []),
      ...attention.map((c, i) => item(h_flex().id(`pr-check-${i}`).h(28).px(8).gap(8).items_center().rounded(7).text_size(12)
        .when(Boolean(c.url), (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => openUrl(c.url)))
        .child(div().w(14).text_color(c.state === "fail" ? t.ansi1 : t.ansi3).child(c.state === "fail" ? "✗" : "◷"))
        .child(div().flex_1().min_w(0).truncate().child(c.name ?? "check")), c.url ? () => openUrl(c.url) : null)),
      item(heading(t, threads ? `Unresolved review comments · ${threads}` : "No unresolved review comments")),
      ...p.threads.map((x, i) => item(card(`pr-thread-${i}`).hover((st) => st.bg(t.hover))
        .child(h_flex().gap(6).text_size(12)
          .child(linkStyle(t, `pr-thread-link-${i}`, `${x.path.split("/").pop()}${x.line ? `:${x.line}` : ""}`, x.url))
          .child(div().text_color(t.dim).child(x.author ?? "reviewer")))
        .child(TextView.markdown(`pr-thread-body-${i}`, firstParagraph(x.body))), x.url ? () => openUrl(x.url) : null)),
    ];
    const footer = threads > 0 ? [
      div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child("Into its prompt, not sent yet"),
      button(t, "pr-send", `Send ${threads} to the agent`, () => this.sendThreads(sel, p)),
    ] : null;
    return this.frame(t, head, items, footer);
  }
}

// Dark text on a light state color (Linear's grey "To Do"), white on the rest.
function textOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#1b1b1f" : "#ffffff";
}

const TICKET_GLYPH = { completed: "✔", canceled: "✕", started: "◐", unstarted: "○", backlog: "◌", triage: "◌" };

export class TicketPanel extends Loading {
  init(cx) { super.init(cx, "ticket", 120000); }
  key(sel) { return sel?.ref && sel.linear ? `${sel.ref}` : null; }
  // By its URL, here: other machines may have no Linear token.
  fetch(sel) { return sr(["session", "ticket", sel.machine ? sel.linearUrl : sel.ref], 60000); }

  keys() {
    const k = this.state.status === "ready" ? this.state.value : null;
    return k ? { o: ["Linear", () => openUrl(k.url)] } : {};
  }

  render() {
    const t = theme();
    const sel = selection();
    const s = this.state;
    if (!sel?.task) return this.frame(t, { title: "Ticket" }, [item(note(t, "Select a task or one of its sessions."))]);
    if (!sel.linear) return this.frame(t, { title: "Ticket", subtitle: sel.task }, [item(note(t, "No Linear ticket is linked to this task. Its main session links one when its name, branch or prompt names it; or: showrunner task set-linear."))]);
    const refresh = headButton(t, "tk-refresh", "↻", (_e, cx) => this.reload(cx));
    if (s.status !== "ready") return this.frame(t, { title: "Ticket", badge: sel.linear, subtitle: sel.task, actions: [refresh] }, [item(note(t, s.status === "error" ? s.message : "Loading the ticket…"))]);
    const k = s.value;
    const comments = k.comments?.nodes ?? [];
    const head = { title: "Ticket", badge: k.identifier, subtitle: sel.task, actions: [headButton(t, "tk-open", "Linear ↗", () => openUrl(k.url)), refresh] };
    const items = [
      item(v_flex().p(8).gap(8)
        .child(h_flex().gap(8).flex_wrap().items_center()
          .child(pill(`${TICKET_GLYPH[k.state?.type] ?? "◇"} ${k.state?.name ?? ""}`, k.state?.color ?? t.accent, /^#[0-9a-f]{6}$/i.test(k.state?.color ?? "") ? textOn(k.state.color) : "#ffffff"))
          .children((k.labels?.nodes ?? []).map((l) => h_flex().gap(4).items_center().text_size(12)
            .child(div().size(7).rounded(4).bg(l.color)).child(div().text_color(t.muted).child(l.name)))))
        .child(div().text_size(15).font_semibold().child(k.title))
        .child(h_flex().gap(12).flex_wrap().text_size(12).text_color(t.muted)
          .child(div().child(k.assignee ? `👤 ${k.assignee.displayName}` : "👤 unassigned"))
          .when(k.priorityLabel && k.priorityLabel !== "No priority", (el) => el.child(div().child(`⚑ ${k.priorityLabel}`)))
          .when(Boolean(k.creator), (el) => el.child(div().child(`✎ ${k.creator.displayName}`))))),
      item(div().px(8).pb(8).child(TextView.markdown("tk-description", k.description?.trim() || "_No description._"))),
      ...(comments.length ? [item(heading(t, `Comments · ${comments.length}`))] : []),
      ...comments.map((c, i) => item(card(`tk-comment-${i}`)
        .child(div().text_size(12).text_color(t.dim).child(`${c.user?.displayName ?? "someone"} · ${c.createdAt.slice(0, 10)}`))
        .child(TextView.markdown(`tk-comment-body-${i}`, c.body)))),
    ];
    return this.frame(t, head, items);
  }
}

const WORK_PROMPT =
  "Work through the ideas in my idea queue (`showrunner ideas list`). Decide the order yourself, tell me the order before you start, and tick each one off as you finish it (`showrunner ideas start <id>`, `showrunner ideas done <id>`).";

// The task's idea queue: jot ideas down while its sessions work; send one to
// the agent on its own, or have it work through them all.
export class IdeasPanel extends Loading {
  init(cx) {
    super.init(cx, "ideas", 3000);
    this.draft = "";
    this.input = InputState.new({ placeholder: "An idea for later…" });
    this.input.on("change", (_e, cx) => { this.draft = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.add(cx));
    this.input.on("focus", (_e, cx) => { this.adding = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.adding = false; cx.notify(); });
    this.editing = null;
    this.edit = InputState.new({});
    this.edit.on("submit", (_e, cx) => {
      const text = this.edit.value().trim();
      const id = this.editing;
      this.editing = null;
      if (text && id) this.change(cx, ["edit", id, text]);
      this.handle.focus();
      cx.notify();
    });
  }

  key(sel) { return sel?.ref ?? null; }
  fetch(sel) { return sr(["ideas", "list", "--json", "--for", sel.ref], undefined, sel.machine); }

  get pickLabel() {
    const idea = this.state.status === "ready" ? this.state.value[this.pos] : null;
    return idea && !idea.sent && !idea.started ? "send" : null;
  }
  typing() { return this.adding || Boolean(this.editing); }
  escape() { this.editing = null; }

  keys() {
    const list = this.state.status === "ready" ? this.state.value : [];
    const idea = list[this.pos];
    const open = idea && !idea.sent && !idea.started;
    return {
      e: [open ? "edit" : null, (cx) => open && this.startEdit(cx, idea)],
      d: [idea ? "delete" : null, (cx) => idea && this.change(cx, ["remove", idea.id])],
      a: ["add", () => this.input.focus()],
      w: [list.filter((x) => !x.sent && !x.started).length > 1 ? "work through all" : null, (cx) => this.workThrough(cx)],
    };
  }

  startEdit(cx, idea) {
    this.editing = idea.id;
    this.edit.set_value(idea.text);
    this.edit.focus();
    cx.notify();
  }

  add(cx) {
    const text = this.input.value().trim();
    if (!text) return;
    this.input.set_value("");
    this.draft = "";
    this.change(cx, ["add", text]);
  }

  change(cx, args) {
    const sel = selection();
    if (!sel?.ref) return;
    cx.spawn(async (cx) => {
      const r = await sr(["ideas", ...args, "--for", sel.ref], undefined, sel.machine);
      if (r.code !== 0) notify({ title: "The idea queue didn't change", body: clean(r.stderr), level: "error" });
      this.reload(cx);
    });
  }

  send(cx, idea) {
    const sel = selection();
    const prompt = `${idea.text}\n\n(From my idea queue, id ${idea.id}: mark it started and done with \`showrunner ideas start ${idea.id}\` and \`showrunner ideas done ${idea.id}\`.)`;
    cx.spawn(async (cx) => {
      const r = await sr(["send", sel.ref, prompt], undefined, sel.machine);
      if (r.code !== 0) return notify({ title: "Couldn't send the idea", body: clean(r.stderr), level: "error" });
      await sr(["ideas", "sent", idea.id, "--for", sel.ref], undefined, sel.machine);
      notify({ title: "Sent: it runs as soon as the session is free.", level: "success", timeout: 3000 });
      this.reload(cx);
    });
  }

  workThrough(cx) {
    const sel = selection();
    cx.spawn(async () => {
      const r = await sr(["send", sel.ref, WORK_PROMPT], undefined, sel.machine);
      notify(r.code === 0
        ? { title: "The session works through the queue once it is free.", level: "success", timeout: 3000 }
        : { title: "Couldn't ask the session", body: clean(r.stderr), level: "error" });
    });
  }

  render() {
    const t = theme();
    const sel = selection();
    if (!sel?.ref) return this.frame(t, { title: "Ideas" }, [item(note(t, "Select a task or session: its ideas show here."))]);
    const list = this.state.status === "ready" ? this.state.value : [];
    const waiting = list.filter((x) => !x.sent && !x.started);
    const where = sel.task ?? `${sel.crumbs?.[0] ?? ""} adhoc`;
    const small = (id, label, onClick) => div().id(id).px(6).h(22).flex().flex_none().items_center().rounded(5).text_size(12).text_color(t.dim)
      .cursor_pointer().hover((s) => s.bg(t.raised).text_color(t.foreground)).on_click(onClick).child(label);
    const head = {
      title: "Ideas",
      badge: list.length ? `${list.length} queued` : null,
      subtitle: where,
      actions: waiting.length > 1 ? [headButton(t, "ideas-work", `Work through all ${waiting.length} ↗`, (_e, cx) => this.workThrough(cx))] : [],
    };
    const empty = this.state.status === "error" ? this.state.message
      : list.length ? null
      : this.state.status === "ready" ? "Jot down ideas here while the sessions work. Send one on its own, or let the session work through them all."
      : "Loading ideas…";
    const items = empty ? [item(note(t, empty))] : list.map((idea, i) => {
        const mark = idea.started ? ["●", t.ansi3, "the session is on it"] : idea.sent ? ["↗", t.accent, "sent, waiting for the session"] : ["○", t.dim, null];
        const canEdit = !idea.sent && !idea.started;
        if (this.editing === idea.id)
          return item(h_flex().px(8).py(4).gap(8).items_center()
            .child(div().w(14).text_color(t.accent).child("✎"))
            .child(div().flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.accent)
              .child(Input.new(this.edit).h_full().text_size(12).text_color(t.foreground)))
            .child(small(`idea-cancel-${idea.id}`, "Cancel", (_e, cx) => { this.editing = null; cx.notify(); })), () => {});
        return item(h_flex().id(`idea-${idea.id}`).min_h(28).px(8).py(5).gap(8).items_start().rounded(7).hover((s) => s.bg(t.hover))
          .child(div().w(14).text_color(mark[1]).child(mark[0]))
          .child(v_flex().flex_1().min_w(0)
            .child(h_flex().gap(5).items_start().child(div().text_color(t.dim).child(`${i + 1}.`)).child(div().flex_1().min_w(0).child(idea.text)))
            .when(Boolean(mark[2]), (el) => el.child(div().text_size(11).text_color(mark[1]).child(mark[2]))))
          .when(canEdit, (el) => el.child(small(`idea-edit-${idea.id}`, "✎", (_e, cx) => this.startEdit(cx, idea))))
          .when(canEdit, (el) => el.child(small(`idea-send-${idea.id}`, "send ↗", (_e, cx) => this.send(cx, idea))))
          .child(small(`idea-remove-${idea.id}`, "×", (_e, cx) => this.change(cx, ["remove", idea.id]))), (cx) => canEdit && this.send(cx, idea));
      });
    const footer = [
      div().id("idea-new").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.adding ? t.accent : t.border)
        .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)),
      button(t, "idea-add", "Add", (_e, cx) => this.add(cx), Boolean(this.draft.trim())),
    ];
    return this.frame(t, head, items, footer);
  }
}

// What the selected session's Claude is doing, read from its conversation
// (`showrunner session activity`), as the activity Claude mod shows it: the
// main session and its subagents (nested under whoever started them), each
// with its task list, its shell commands (the last lines they wrote) and the
// call under way; the turn's time, progress and context fill on top. The
// newest work is at the end, which the list keeps in view: the main session and
// its subagents in the order they last did something, finished subagents
// folded. Enter or a click folds an agent or a command; c clears what has finished.
const ENDED = new Set(["completed", "failed", "killed"]);

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const since = (start, end) => (start ? duration((end ? Date.parse(end) : Date.now()) - Date.parse(start)) : "");

// When a loop last did something (timestamps sort as text).
const lastActive = (l) => [l.started_at, l.ended_at, l.turn_started_at, l.current_at,
  ...l.shells.flatMap((s) => [s.started_at, s.ended_at]), ...l.tasks.flatMap((x) => [x.started_at, x.ended_at])]
  .filter(Boolean).sort().at(-1) ?? "";

export class ActivityPanel extends Loading {
  init(cx) {
    // The newest work is at the end: the list keeps to it.
    super.init(cx, "activity", 1500, true);
    // Agents and commands opened or shut against how they'd be by default.
    this.flipped = new Set();
    // Per conversation: what ended before this was cleared away.
    this.cleared = {};
    // Output fetched for a copy button, written from a timer: a click's
    // context is gone by the time the fetch answers.
    cx.timer.every(200, (cx) => {
      if (!this.toCopy) return;
      this.copy(cx, ...this.toCopy);
      this.toCopy = null;
    });
  }

  key(sel) { return sel?.conversation ?? null; }
  fetch(sel) { return sr(["session", "activity", sel.conversation], undefined, sel.machine); }
  get pickLabel() { return "fold"; }
  keys() { return this.hasFinished() ? { c: ["clear finished", () => this.clear()] } : {}; }

  // The board less what was cleared away.
  board() {
    if (this.state.status !== "ready") return null;
    const cut = this.cleared[this.state.key] ?? "";
    const gone = (end) => Boolean(end) && end <= cut;
    const loops = this.state.value.loops
      .filter((l) => l.id === "main" || !(ENDED.has(l.status) && gone(l.ended_at)))
      .map((l) => ({
        ...l,
        shells: l.shells.filter((s) => s.status === "running" || !gone(s.ended_at)),
        tasks: l.tasks.length && l.tasks.every((x) => x.status === "completed" && gone(x.ended_at)) ? [] : l.tasks,
      }));
    return { ...this.state.value, loops };
  }

  hasFinished() {
    return (this.board()?.loops ?? []).some((l) => (l.id !== "main" && ENDED.has(l.status))
      || l.shells.some((s) => s.status !== "running")
      || (l.tasks.length > 0 && l.tasks.every((x) => x.status === "completed")));
  }

  clear() {
    if (this.state.status === "ready") this.cleared[this.state.key] = new Date().toISOString();
  }

  // Open by default: every agent; a command while it runs, and the last one
  // until the next starts. Enter or a click flips that.
  isOpen(id, byDefault) { return byDefault !== this.flipped.has(id); }
  flip(id) { if (!this.flipped.delete(id)) this.flipped.add(id); }

  copy(cx, text, what) {
    cx.write_to_clipboard(text);
    notify({ title: `Copied ${what}`, level: "success", timeout: 2000 });
  }

  copyOutput(sel, shell) {
    sr(["session", "activity", sel.conversation, "--output", shell.id], undefined, sel.machine).then((r) => {
      const text = r.code === 0 ? r.stdout.trimEnd() : "";
      if (!text) return notify({ title: "No output to copy", level: "warning", timeout: 2500 });
      const lines = text.split("\n").length;
      this.toCopy = [text, `${lines} line${lines === 1 ? "" : "s"} of output`];
    });
  }

  render() {
    const t = theme();
    const sel = selection();
    const s = this.state;
    const refresh = headButton(t, "act-refresh", "↻", (_e, cx) => this.reload(cx));
    if (!sel?.conversation) return this.frame(t, { title: "Activity" }, [item(note(t, "Select a session, or a task for its main session."))]);
    if (s.status === "loading" || s.status === "idle") return this.frame(t, { title: "Activity", actions: [refresh] }, [item(note(t, "Reading the conversation…"))]);
    if (s.status === "error") return this.frame(t, { title: "Activity", actions: [refresh] }, [item(note(t, s.message))]);

    const b = this.board();
    const main = b.loops.find((l) => l.id === "main");
    const agents = b.loops.filter((l) => l.id !== "main");
    const live = liveSessions()[sel.conversation]?.status;
    let done = 0, total = 0;
    for (const l of b.loops) {
      for (const x of l.tasks) { total += 1; done += x.status === "completed" ? 1 : 0; }
      for (const x of l.shells) { total += 1; done += x.status === "running" ? 0 : 1; }
      if (l.id !== "main") { total += 1; done += ENDED.has(l.status) ? 1 : 0; }
    }
    const facts = [
      main.status === "running" ? `turn ${since(main.turn_started_at)}` : live === "blocked" ? "needs you" : "idle",
      b.context ? `context ${Math.round((100 * b.context.tokens) / b.context.window)}%` : null,
    ].filter(Boolean);

    const spinner = (color) => svg(ICON("spinner")).size(12).flex_none().text_color(color).spin(900);
    const glyph = (status, waiting) => {
      if (status === "running" || status === "pending") return spinner(t.working);
      const [mark, color] = waiting ? ["◔", t.blocked] : { completed: ["✓", t.ansi2], failed: ["✗", t.ansi1], killed: ["■", t.ansi3] }[status] ?? ["○", t.dim];
      return div().w(12).flex_none().text_center().text_size(12).text_color(color).child(mark);
    };
    const right = (text) => div().flex_none().text_size(11).text_color(t.dim).child(text);
    const mono = (el) => el.font_family(settings().font ?? "JetBrains Mono").text_size(11.5);
    const command = (text, dim) => mono(div().pl(20).pr(8).whitespace_normal().text_color(dim ? t.muted : t.foreground).child(`$ ${text}`));
    const items = [];

    const loopItems = (l, depth) => {
      const id = `loop:${l.id}`;
      const isMain = l.id === "main";
      const open = this.isOpen(id, isMain || !ENDED.has(l.status));
      const clock = isMain ? (l.status === "running" ? `turn ${since(l.turn_started_at)}` : "idle") : since(l.started_at, l.ended_at);
      const label = isMain ? l.label : `${l.label}${l.type ? ` · ${l.type}` : ""}`;
      const indent = 6 + depth * 14;
      items.push(item(h_flex().id(`act-${l.id}`).h(28).pl(indent).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
        .hover((st) => st.bg(t.hover)).on_click(() => this.flip(id))
        .child(div().w(10).flex_none().text_size(10).text_color(t.dim).child(open ? "▾" : "▸"))
        .child(glyph(l.status, isMain && live === "blocked"))
        .child(div().flex_1().min_w(0).truncate().when(depth === 0, (el) => el.font_semibold()).child(label))
        .child(right(`${l.tools ? `${l.tools} tool${l.tools === 1 ? "" : "s"} · ` : ""}${clock}`)), () => this.flip(id)));
      if (!open) return;
      const inner = indent + 17;
      for (const x of l.tasks) {
        const finished = x.status === "completed";
        items.push(item(h_flex().h(24).pl(inner).pr(8).gap(7).items_center().text_size(12.5)
          .child(x.status === "in_progress" ? spinner(t.working) : div().w(12).flex_none().text_center().text_color(finished ? t.ansi2 : t.dim).child(finished ? "✓" : "○"))
          .child(div().flex_1().min_w(0).truncate().text_color(finished ? t.dim : t.foreground).when(finished, (el) => el.line_through()).child(x.title))
          .child(right(since(x.started_at, x.ended_at)))));
      }
      const last = l.shells.at(-1);
      for (const x of l.shells) {
        const sid = `shell:${x.id}`;
        const sopen = this.isOpen(sid, x.status === "running" || (x.id === last.id && !l.current));
        const ended = x.status !== "running";
        const copyButton = (key, mark, tip, action) => div().id(`act-copy-${key}-${x.id}`).px(4).flex_none().rounded(4).text_size(11).text_color(t.dim)
          .cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip(tip)
          .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(mark);
        items.push(item(v_flex().pl(inner).gap(2)
          .child(h_flex().id(`act-${x.id}`).h(24).pr(8).gap(7).items_center().rounded(6).cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => this.flip(sid))
            .child(ended ? glyph(x.status) : spinner(t.working))
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(ended ? t.muted : t.foreground).child(x.title ?? `$ ${x.command.replace(/\s+/g, " ")}`))
            .when(sopen, (el) => el.child(copyButton("cmd", "❯", "Copy the command", (cx) => this.copy(cx, x.command, "the command")))
              .child(copyButton("out", "☰", "Copy the output", () => this.copyOutput(sel, x))))
            .child(right(since(x.started_at, x.ended_at))))
          .when(sopen && Boolean(x.title), (el) => el.child(command(x.command, ended)))
          .when(sopen && x.tail.length > 0, (el) => el.child(mono(v_flex().pl(20).pr(8).pb(2).text_color(x.status === "failed" ? t.ansi1 : t.dim)
            .children(x.tail.map((line) => div().whitespace_normal().child(`│ ${line}`)))))), () => this.flip(sid)));
      }
      if (l.current) {
        const label = l.current.replace(/^Bash: /, "");
        const described = l.current_command && label !== l.current_command.replace(/\s+/g, " ").slice(0, 59);
        items.push(item(v_flex().pl(inner).gap(2)
          .child(h_flex().h(24).pr(8).gap(7).items_center()
            .child(spinner(t.accent))
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).italic().text_color(t.accent).child(l.current_command && !described ? `$ ${l.current_command}` : `↳ ${label}`))
            .child(right(since(l.current_at))))
          .when(Boolean(described), (el) => el.child(command(l.current_command, false)))));
      }
      if (!isMain) for (const child of agents.filter((c) => c.parent === l.id)) loopItems(child, depth + 1);
    };

    if (total > 0) {
      const pct = Math.round((100 * done) / total);
      items.push(item(h_flex().px(8).pt(6).pb(4).gap(8).items_center()
        .child(div().flex_1().h(4).rounded(2).bg(t.border).child(div().h_full().rounded(2).bg(done === total ? t.ansi2 : t.accent).w(`${pct}%`)))
        .child(div().flex_none().text_size(11.5).font_semibold().child(`${pct}%`))
        .child(right(`${done}/${total}`))));
    }
    const sections = [main, ...agents.filter((a) => a.parent === "main")].sort((a, b) => lastActive(a).localeCompare(lastActive(b)));
    for (const section of sections) loopItems(section, 0);
    if (!main.tasks.length && !main.shells.length && !main.current && !agents.length) {
      items.push(item(note(t, "Nothing yet: tasks, commands and subagents show here as the session works.")));
    }
    const footer = this.hasFinished() ? [div().flex_1(), button(t, "act-clear", "Clear finished", () => this.clear(), false)] : null;
    return this.frame(t, { title: "Activity", badge: total ? `${done}/${total}` : null, subtitle: facts.join(" · "), actions: [refresh] }, items, footer);
  }
}
