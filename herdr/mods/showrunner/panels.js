// The right panel's showrunner views, following the tree's selection: the
// task's Linear ticket, its PR (checks, open review comments to hand to the
// agent) and its idea queue. They look like Herdr's Files and Changes, and
// their buttons sit beside Files and Changes in the top bar.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { shared, theme, layout, notify, run } from "herdr";
import { sr, clean, openUrl, reveal } from "./lib.js";
import { ICON } from "./ui.js";

export const PANELS = [
  { id: "files", label: "Files", key: "f", icon: "mods/files/file.svg" },
  { id: "changes", label: "Changes", key: "c", icon: "mods/changes/changes.svg" },
  { id: "ideas", label: "Ideas", key: "i", icon: ICON("lightbulb") },
  { id: "pr", label: "PR", key: "p", icon: ICON("git-pull-request") },
  { id: "ticket", label: "Ticket", key: "t", icon: ICON("ticket") },
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
    const usable = { ideas: Boolean(sel?.ref), pr: Boolean(sel?.task), ticket: Boolean(sel?.linear) };
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

// Laid out like Herdr's Files and Changes: a card with a header (title, a
// badge, a dim subtitle on the right), a scrolling body and an action bar.
function frame(t, view, head, body, footer) {
  return v_flex().id(view).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
    .text_color(t.foreground).text_size(13)
    .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child(head.title))
      .when(Boolean(head.badge), (el) => el.child(div().px(5).py(1).flex_none().rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(head.badge)))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(head.subtitle ?? ""))
      .children(head.actions ?? []))
    .child(v_flex().id(`${view}-body`).flex_1().min_h(0).overflow_y_scrollbar().p(6).child(body))
    .when(Boolean(footer), (el) => el.child(h_flex().flex_none().p(10).gap(8).items_center().border_t(1).border_color(t.border).children(footer)));
}

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

// Loads a view's data for the selection's task; again when it changes, and
// every `every` ms while the view is shown.
class Loading {
  init(cx, view, every) {
    this.view = view;
    this.state = { status: "idle" };
    this.loaded = null;
    cx.timer.every(1000, (cx) => {
      const sel = selection();
      const key = this.key(sel);
      if (!visible(view)) return;
      if (key !== this.loaded || (key && Date.now() - (this.at ?? 0) > every)) this.load(cx, sel, key);
    });
  }

  load(cx, sel, key) {
    this.loaded = key;
    this.at = Date.now();
    if (!key) { this.state = { status: "idle" }; return cx.notify(); }
    if (this.state.status !== "ready" || this.state.key !== key) this.state = { status: "loading" };
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
}

export class PrPanel extends Loading {
  init(cx) { super.init(cx, "pr", 60000); }
  key(sel) { return sel?.ref && sel.task ? `${sel.ref}` : null; }
  fetch(sel) { return sr(["session", "pr", sel.ref], 60000); }

  sendThreads(sel, pr) {
    const text = pr.threads.map((x) => `- ${x.path}${x.line ? `:${x.line}` : ""} (${x.author ?? "reviewer"}): ${firstParagraph(x.body)}`).join("\n");
    sr(["send", sel.ref, `Address these unresolved review comments on the PR:\n${text}\n`, "--no-submit"]).then((r) => {
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
    if (!sel?.task) return frame(t, "pr", { title: "Pull request" }, note(t, "Select a task or one of its sessions."));
    if (s.status === "loading" || s.status === "idle") return frame(t, "pr", { title: "Pull request", subtitle: sel.task, actions: [refresh] }, note(t, "Loading the pull request…"));
    if (s.status === "error") return frame(t, "pr", { title: "Pull request", subtitle: sel.task, actions: [refresh] }, note(t, s.message), [
      div().flex_1(),
      button(t, "pr-create", "Push and open a draft PR", () => {
        sr(["task", "pr", sel.project, sel.task, "--create"], 300000).then((r) =>
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
    const body = v_flex()
      .child(v_flex().p(8).gap(8)
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
          .when(count("skipped") > 0, (el) => el.child(div().text_color(t.dim).child(`⤼ ${count("skipped")} skipped`)))))
      .when(attention.length > 0, (el) => el.child(heading(t, "Checks"))
        .children(attention.map((c, i) => h_flex().id(`pr-check-${i}`).h(28).px(8).gap(8).items_center().rounded(7).text_size(12)
          .when(Boolean(c.url), (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => openUrl(c.url)))
          .child(div().w(14).text_color(c.state === "fail" ? t.ansi1 : t.ansi3).child(c.state === "fail" ? "✗" : "◷"))
          .child(div().flex_1().min_w(0).truncate().child(c.name ?? "check")))))
      .child(heading(t, threads ? `Unresolved review comments · ${threads}` : "No unresolved review comments"))
      .children(p.threads.map((x, i) => card(`pr-thread-${i}`).hover((st) => st.bg(t.hover))
        .child(h_flex().gap(6).text_size(12)
          .child(linkStyle(t, `pr-thread-link-${i}`, `${x.path.split("/").pop()}${x.line ? `:${x.line}` : ""}`, x.url))
          .child(div().text_color(t.dim).child(x.author ?? "reviewer")))
        .child(TextView.markdown(`pr-thread-body-${i}`, firstParagraph(x.body)))));
    const footer = threads > 0 ? [
      div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child("Into its prompt, not sent yet"),
      button(t, "pr-send", `Send ${threads} to the agent`, () => this.sendThreads(sel, p)),
    ] : null;
    return frame(t, "pr", head, body, footer);
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
  fetch(sel) { return sr(["session", "ticket", sel.ref], 60000); }

  render() {
    const t = theme();
    const sel = selection();
    const s = this.state;
    if (!sel?.task) return frame(t, "ticket", { title: "Ticket" }, note(t, "Select a task or one of its sessions."));
    if (!sel.linear) return frame(t, "ticket", { title: "Ticket", subtitle: sel.task }, note(t, "No Linear ticket is linked to this task. Its main session links one when its name, branch or prompt names it; or: showrunner task set-linear."));
    const refresh = headButton(t, "tk-refresh", "↻", (_e, cx) => this.reload(cx));
    if (s.status !== "ready") return frame(t, "ticket", { title: "Ticket", badge: sel.linear, subtitle: sel.task, actions: [refresh] }, note(t, s.status === "error" ? s.message : "Loading the ticket…"));
    const k = s.value;
    const comments = k.comments?.nodes ?? [];
    const head = { title: "Ticket", badge: k.identifier, subtitle: sel.task, actions: [headButton(t, "tk-open", "Linear ↗", () => openUrl(k.url)), refresh] };
    const body = v_flex()
      .child(v_flex().p(8).gap(8)
        .child(h_flex().gap(8).flex_wrap().items_center()
          .child(pill(`${TICKET_GLYPH[k.state?.type] ?? "◇"} ${k.state?.name ?? ""}`, k.state?.color ?? t.accent, /^#[0-9a-f]{6}$/i.test(k.state?.color ?? "") ? textOn(k.state.color) : "#ffffff"))
          .children((k.labels?.nodes ?? []).map((l) => h_flex().gap(4).items_center().text_size(12)
            .child(div().size(7).rounded(4).bg(l.color)).child(div().text_color(t.muted).child(l.name)))))
        .child(div().text_size(15).font_semibold().child(k.title))
        .child(h_flex().gap(12).flex_wrap().text_size(12).text_color(t.muted)
          .child(div().child(k.assignee ? `👤 ${k.assignee.displayName}` : "👤 unassigned"))
          .when(k.priorityLabel && k.priorityLabel !== "No priority", (el) => el.child(div().child(`⚑ ${k.priorityLabel}`)))
          .when(Boolean(k.creator), (el) => el.child(div().child(`✎ ${k.creator.displayName}`)))))
      .child(div().px(8).pb(8).child(TextView.markdown("tk-description", k.description?.trim() || "_No description._")))
      .when(comments.length > 0, (el) => el.child(heading(t, `Comments · ${comments.length}`))
        .children(comments.map((c, i) => card(`tk-comment-${i}`)
          .child(div().text_size(12).text_color(t.dim).child(`${c.user?.displayName ?? "someone"} · ${c.createdAt.slice(0, 10)}`))
          .child(TextView.markdown(`tk-comment-body-${i}`, c.body)))));
    return frame(t, "ticket", head, body);
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
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.editing = null;
    this.edit = InputState.new({});
    this.edit.on("submit", (_e, cx) => {
      const text = this.edit.value().trim();
      const id = this.editing;
      this.editing = null;
      if (text && id) this.change(cx, ["edit", id, text]);
      cx.notify();
    });
  }

  key(sel) { return sel?.ref ?? null; }
  fetch(sel) { return sr(["ideas", "list", "--json", "--for", sel.ref]); }

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
      const r = await sr(["ideas", ...args, "--for", sel.ref]);
      if (r.code !== 0) notify({ title: "The idea queue didn't change", body: clean(r.stderr), level: "error" });
      this.reload(cx);
    });
  }

  send(cx, idea) {
    const sel = selection();
    const prompt = `${idea.text}\n\n(From my idea queue, id ${idea.id}: mark it started and done with \`showrunner ideas start ${idea.id}\` and \`showrunner ideas done ${idea.id}\`.)`;
    cx.spawn(async (cx) => {
      const r = await sr(["send", sel.ref, prompt]);
      if (r.code !== 0) return notify({ title: "Couldn't send the idea", body: clean(r.stderr), level: "error" });
      await sr(["ideas", "sent", idea.id, "--for", sel.ref]);
      notify({ title: "Sent: it runs as soon as the session is free.", level: "success", timeout: 3000 });
      this.reload(cx);
    });
  }

  workThrough(cx) {
    const sel = selection();
    cx.spawn(async () => {
      const r = await sr(["send", sel.ref, WORK_PROMPT]);
      notify(r.code === 0
        ? { title: "The session works through the queue once it is free.", level: "success", timeout: 3000 }
        : { title: "Couldn't ask the session", body: clean(r.stderr), level: "error" });
    });
  }

  render() {
    const t = theme();
    const sel = selection();
    if (!sel?.ref) return frame(t, "ideas", { title: "Ideas" }, note(t, "Select a task or session: its ideas show here."));
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
    const body = v_flex()
      .when(this.state.status === "loading" && !list.length, (el) => el.child(note(t, "Loading ideas…")))
      .when(this.state.status === "error", (el) => el.child(note(t, this.state.message)))
      .when(this.state.status === "ready" && !list.length, (el) => el.child(note(t, "Jot down ideas here while the sessions work. Send one on its own, or let the session work through them all.")))
      .children(list.map((idea, i) => {
        const mark = idea.started ? ["●", t.ansi3, "the session is on it"] : idea.sent ? ["↗", t.accent, "sent, waiting for the session"] : ["○", t.dim, null];
        const canEdit = !idea.sent && !idea.started;
        if (this.editing === idea.id)
          return h_flex().px(8).py(4).gap(8).items_center()
            .child(div().w(14).text_color(t.accent).child("✎"))
            .child(div().flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.accent)
              .child(Input.new(this.edit).h_full().text_size(12).text_color(t.foreground)))
            .child(small(`idea-cancel-${idea.id}`, "Cancel", (_e, cx) => { this.editing = null; cx.notify(); }));
        return h_flex().id(`idea-${idea.id}`).min_h(28).px(8).py(5).gap(8).items_start().rounded(7).hover((s) => s.bg(t.hover))
          .child(div().w(14).text_color(mark[1]).child(mark[0]))
          .child(v_flex().flex_1().min_w(0)
            .child(h_flex().gap(5).items_start().child(div().text_color(t.dim).child(`${i + 1}.`)).child(div().flex_1().min_w(0).child(idea.text)))
            .when(Boolean(mark[2]), (el) => el.child(div().text_size(11).text_color(mark[1]).child(mark[2]))))
          .when(canEdit, (el) => el.child(small(`idea-edit-${idea.id}`, "✎", (_e, cx) => { this.editing = idea.id; this.edit.set_value(idea.text); this.edit.focus(); cx.notify(); })))
          .when(canEdit, (el) => el.child(small(`idea-send-${idea.id}`, "send ↗", (_e, cx) => this.send(cx, idea))))
          .child(small(`idea-remove-${idea.id}`, "×", (_e, cx) => this.change(cx, ["remove", idea.id])));
      }));
    const footer = [
      div().id("idea-new").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border)
        .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)),
      button(t, "idea-add", "Add", (_e, cx) => this.add(cx), Boolean(this.draft.trim())),
    ];
    return frame(t, "ideas", head, body, footer);
  }
}
