// The tree's popups and dialogs: the `a` menu, forms, fuzzy pickers and
// confirmations. Each runs its action itself; the tree refreshes after.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { props, closeOverlay, theme, settings, pickFolder, home, run } from "herdr";
import { menuItems, enqueue, show } from "./lib.js";
import { FORMS, PICKERS, agentChoices, loadKnownAgents, toBranch } from "./actions.js";
import { icon, keycap, statusGlyph } from "./ui.js";
import { showPanel, panelFocus } from "./panels.js";

// Closing gives the keyboard back to the tree, then has it run `jobs` (which
// may move the keyboard on). Queued first: a closed popup changes nothing.
const close = (...jobs) => {
  enqueue({ kind: "focus" });
  for (const job of jobs) enqueue(job);
  closeOverlay(props().overlay);
};

function title(t, text, hint) {
  return h_flex().items_center().gap(8)
    .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(text))
    .child(div().text_size(11).text_color(t.dim).child(hint ?? "Esc"));
}

function button(t, id, label, primary, onClick, danger) {
  const bg = danger ? t.blocked : primary ? t.solid : t.raised;
  return h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
    .border_color(primary || danger ? bg : t.input).bg(bg)
    .text_color(danger ? t.background : primary ? t.solid_foreground : t.foreground)
    .text_size(12.5).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
}

// The `a` menu: the TUI's actions for the item, each on its key.
export class Menu {
  init(cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  entries() {
    const p = props();
    return p.entries ?? menuItems(p.item);
  }

  choose(entry) {
    if (!entry) return;
    if (entry.action.startsWith("panel:")) {
      const view = entry.action.slice(6);
      if (!view) {
        run("layout.hide", { id: "panel" });
        return this.close();
      }
      showPanel(view);
      // A panel that takes the keyboard gets it; Files keeps it where it was.
      const focus = panelFocus(view);
      if (!focus) return this.close();
      closeOverlay(props().overlay);
      return run(focus);
    }
    close({ kind: "perform", action: entry.action, item: props().item });
  }

  // Back to where the keyboard was when the menu opened: the tree, or a pane.
  close() {
    const back = props().back;
    if (back === undefined || back === "tree") return close();
    if (back) run("pane.focus", { pane: back });
    closeOverlay(props().overlay);
  }

  render() {
    const t = theme();
    const list = this.entries();
    const item = props().item ?? {};
    const heading = props().title ?? (item.session?.name ? `${item.task?.name ?? "adhoc"} · ${item.session.name}` : item.task?.name ?? item.group ?? item.project?.name);
    return v_flex().id("sr-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        const k = e.key.length === 1 ? e.key_char ?? e.key : e.key;
        if (e.key === "down" || (k === "j" && !list.some((x) => x.key === "j"))) this.at = (this.at + 1) % list.length;
        else if (e.key === "up" || (k === "k" && !list.some((x) => x.key === "k"))) this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(list[this.at]);
        else if (e.key === "escape" || k === "q") this.close();
        else {
          const hit = list.find((x) => x.key === k);
          if (!hit) return;
          this.choose(hit);
        }
        cx.stop_propagation();
        cx.notify();
      })
      .child(div().px(8).pt(5).pb(6).text_size(11).text_color(t.dim).truncate().child(heading ?? ""))
      .children(list.map((x, i) =>
        v_flex()
          .when(Boolean(x.danger) && i > 0, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
          .child(h_flex().id(`sr-mi-${i}`).h(30).px(8).gap(9).rounded(7).items_center()
            .text_color(x.danger ? t.blocked : t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.choose(x))
            .child(keycap(t, x.key, i === this.at))
            .when(Boolean(x.icon), (el) => el.child(svg(x.icon).size(14).flex_none().text_color(t.muted)))
            .child(div().flex_1().truncate().child(x.label))
            .when(Boolean(x.on), (el) => el.child(icon("check", 13, t.accent))))));
  }
}

// A form: text fields, an agent choice, Enter (⌘Enter in a long field) submits.
export class Form {
  init(cx) {
    const p = props();
    const spec = FORMS[p.form];
    this.spec = spec;
    this.values = {};
    this.inputs = {};
    this.error = null;
    this.branchEdited = false;
    this.handle = cx.focus_handle();
    for (const f of spec.fields) {
      if (f.agent) { this.values[f.id] = p.item?.project?.agent ?? "claude"; continue; }
      const value = typeof f.value === "function" ? f.value(p) : f.value ?? "";
      this.values[f.id] = value;
      const state = f.multiline
        ? TextareaState.new({ placeholder: f.placeholder ?? "", value, rows: 4 })
        : InputState.new({ placeholder: f.placeholder ?? "", value });
      state.on("change", (_e, cx) => {
        this.values[f.id] = state.value();
        if (f.id === "branch") this.branchEdited = state.value() !== toBranch(this.values.name ?? "");
        const derived = spec.fields.find((x) => x.derive === f.id);
        if (derived && !this.branchEdited) {
          this.values[derived.id] = toBranch(state.value());
          this.inputs[derived.id].set_value(this.values[derived.id]);
        }
        this.error = null;
        cx.notify();
      });
      state.on("submit", (_e, cx) => { this.submit(); cx.notify(); });
      state.on("focus", (_e, cx) => { this.focusedField = f.id; cx.notify(); });
      this.inputs[f.id] = state;
    }
    const first = spec.fields.find((f) => !f.agent);
    this.focusedField = p.chooseAgent ? "agent" : first?.id;
    if (p.chooseAgent) this.handle.focus();
    else if (first) {
      this.inputs[first.id].focus();
      cx.timer.after(300, () => this.inputs[first.id]?.focus());
    }
    if (spec.fields.some((f) => f.agent)) {
      this.agents = agentChoices(null);
      cx.spawn(async (cx) => {
        this.agents = agentChoices(await loadKnownAgents());
        cx.notify();
      });
    }
  }

  submit() {
    const p = props();
    const error = this.spec.submit(this.values, p);
    if (typeof error === "string") { this.error = error; return; }
    close();
  }

  // Tab and shift-Tab move between fields, agents included.
  cycle(back) {
    const ids = this.spec.fields.map((f) => f.id);
    const i = ids.indexOf(this.focusedField);
    const next = ids[(i + (back ? ids.length - 1 : 1)) % ids.length];
    this.focusedField = next;
    if (this.inputs[next]) this.inputs[next].focus();
    else this.handle.focus();
  }

  render() {
    const t = theme();
    const p = props();
    const spec = this.spec;
    const label = (text) => div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(text);
    const hint = typeof spec.hint === "function" ? spec.hint(p) : spec.hint;
    const field = (f) => {
      if (f.agent) return v_flex().child(label(f.label)).child(this.agentRow(t));
      const focusedHere = this.focusedField === f.id;
      const box = f.multiline ? Textarea.new(this.inputs[f.id]) : Input.new(this.inputs[f.id]);
      return v_flex().child(label(f.label))
        .child(box.when(!f.multiline, (el) => el.h(36)).px(10).py(f.multiline ? 8 : 0).rounded(9).border_1()
          .border_color(focusedHere ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
        .when(f.id === "path", (el) => el.child(this.browse(t)));
    };
    return v_flex().id("sr-form").track_focus(this.handle).w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") close();
        else if (e.key === "tab") this.cycle(e.modifiers.shift);
        else if (e.key === "enter" && (e.modifiers.platform || this.focusedField === "agent")) this.submit();
        else if (this.focusedField === "agent" && (e.key === "left" || e.key === "right")) this.stepAgent(e.key === "right" ? 1 : -1);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(title(t, spec.title(p)))
      .children(spec.fields.map(field))
      .when(Boolean(hint), (el) => el.child(div().pt(10).text_size(11.5).text_color(t.dim).child(hint)))
      .when(Boolean(this.error), (el) => el.child(div().pt(10).text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().pt(18).gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim)
          .child(`${spec.fields.some((f) => f.multiline) ? "⌘↵" : "↵"} ${(spec.action ?? "Create").toLowerCase()}${spec.fields.length > 1 ? " · ⇥ next field" : ""}`))
        .child(button(t, "sr-cancel", "Cancel", false, () => close()))
        .child(button(t, "sr-submit", spec.action ?? "Create", true, (_e, cx) => { this.submit(); cx.notify(); })));
  }

  stepAgent(by) {
    const list = this.agents ?? [];
    const i = list.findIndex((a) => a.id === this.values.agent);
    const next = list[(i + by + list.length) % list.length];
    if (next) this.values.agent = next.id;
  }

  agentRow(t) {
    const focusedHere = this.focusedField === "agent";
    return h_flex().gap(6).p(3).rounded(9).border_1().border_color(focusedHere ? t.accent : t.chrome)
      .children((this.agents ?? []).map((a) => {
        const on = this.values.agent === a.id;
        const pic = a.icon ? (a.tint ? svg(a.icon).size(14).text_color(on ? t.foreground : t.muted) : image(a.icon).size(14)) : null;
        return h_flex().id(`sr-agent-${a.id}`).h(30).px(10).gap(7).rounded(7).items_center().flex_1().justify_center()
          .bg(on ? t.selected : t.popover).text_color(on ? t.foreground : a.installed ? t.muted : t.dim)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.values.agent = a.id; this.focusedField = "agent"; cx.notify(); })
          .when(Boolean(pic), (el) => el.child(pic))
          .child(a.name)
          .when(!a.installed, (el) => el.child(div().text_size(10.5).text_color(t.dim).child("not installed")));
      }));
  }

  browse(t) {
    return h_flex().pt(8).child(h_flex().id("sr-browse").h(28).px(10).gap(6).items_center().rounded(7).border_1().border_color(t.input)
      .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.spawn(async (cx) => {
          const folder = await pickFolder({ prompt: "Add project" });
          if (!folder) return;
          this.values.path = folder;
          this.inputs.path.set_value(folder);
          if (this.inputs.name && !this.values.name) {
            this.values.name = folder.replace(/\/+$/, "").split("/").pop();
            this.inputs.name.set_value(this.values.name);
          }
          cx.notify();
        });
      })
      .child(icon("folder", 13)).child("Choose a folder…"));
  }
}

// A fuzzy list: branches, base branches, groups. Type to filter, ↑/↓, Enter.
export class Picker {
  init(cx) {
    const p = props();
    this.spec = PICKERS[p.picker];
    this.items = null;
    this.error = null;
    this.query = "";
    this.at = 0;
    this.input = InputState.new({ placeholder: "Type to filter" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => { this.pick(this.matches()[this.at]); cx.notify(); });
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    cx.spawn(async (cx) => {
      try {
        this.items = await this.spec.load(p);
        const current = this.spec.current?.(p);
        if (current) this.at = Math.max(0, this.items.indexOf(current));
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  matches() {
    const q = this.query.trim();
    const scored = (this.items ?? []).map((x, i) => [fuzzy(q, x), i, x]).filter(([s]) => s !== null)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , x]) => ({ value: x }));
    if (this.spec.create && q && !(this.items ?? []).includes(q)) scored.unshift({ value: q, create: true });
    return scored;
  }

  pick(entry) {
    if (!entry) return;
    this.spec.pick(entry.value, props());
    close();
  }

  render() {
    const t = theme();
    const p = props();
    const list = this.matches();
    this.at = Math.min(this.at, Math.max(0, list.length - 1));
    const current = this.spec.current?.(p);
    const ROW = 30, MAX = 300;
    const start = Math.max(0, Math.min(this.at - Math.floor(MAX / ROW / 2), list.length - Math.floor(MAX / ROW)));
    const shown = list.slice(start, start + Math.floor(MAX / ROW));
    return v_flex().id("sr-picker").w_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") close();
        else if (e.key === "down") this.at = Math.min(list.length - 1, this.at + 1);
        else if (e.key === "up") this.at = Math.max(0, this.at - 1);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(title(t, this.spec.title(p)))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(icon("search", 15, t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .child(v_flex().h(MAX).min_h(0).gap(0)
        .when(this.items === null && !this.error, (el) => el.child(div().p(8).text_color(t.dim).child("Loading…")))
        .when(Boolean(this.error), (el) => el.child(div().p(8).text_color(t.blocked).child(this.error)))
        .when(this.items !== null && !list.length, (el) => el.child(div().p(8).text_color(t.dim).child("Nothing matches")))
        .children(shown.map((x, i) => {
          const index = start + i;
          return h_flex().id(`sr-pk-${index}`).h(ROW).flex_none().px(10).gap(8).rounded(7).items_center()
            .when(index === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.pick(x))
            .child(icon(x.create ? "plus" : p.picker === "group" ? "layers" : "git-branch", 13, t.dim))
            .child(div().flex_1().truncate().text_color(t.foreground).child(x.create ? `Create “${x.value}”` : x.value))
            .when(x.value === current && !x.create, (el) => el.child(icon("check", 13, t.accent)));
        })));
  }
}

// The session switcher (⌘K): the tree's running sessions in its order, fuzzy
// filtered; Enter shows one with the keyboard in its terminal.
export class Switcher {
  init(cx) {
    this.query = "";
    this.at = 0;
    this.input = InputState.new({ placeholder: "Jump to a session" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => { this.pick(this.matches()[this.at]); cx.notify(); });
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
  }

  matches() {
    const q = this.query.trim();
    return (props().entries ?? []).map((x, i) => [fuzzy(q, x.label), i, x]).filter(([s]) => s !== null)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , x]) => x);
  }

  pick(x) {
    if (!x) return;
    show(x.space, x.tab, x.address, true);
    closeOverlay(props().overlay);
  }

  // Back to where the keyboard was: the tree, or a pane.
  cancel() {
    const back = props().back;
    if (back === "tree") return close();
    if (back) run("pane.focus", { pane: back });
    closeOverlay(props().overlay);
  }

  render() {
    const t = theme();
    const list = this.matches();
    this.at = Math.min(this.at, Math.max(0, list.length - 1));
    const ROW = 32, MAX = 320;
    const fit = Math.floor(MAX / ROW);
    const start = Math.max(0, Math.min(this.at - Math.floor(fit / 2), list.length - fit));
    const step = (by) => { this.at = Math.max(0, Math.min(list.length - 1, this.at + by)); };
    const sep = () => div().flex_none().text_color(t.dim).child("–");
    return v_flex().id("sr-switcher").w_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const ctrl = e.modifiers?.control;
        if (e.key === "escape") this.cancel();
        else if (e.key === "down" || (ctrl && e.key === "n")) step(1);
        else if (e.key === "up" || (ctrl && e.key === "p")) step(-1);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(title(t, "Sessions", "↑↓ · Enter · Esc"))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(icon("search", 15, t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .child(v_flex().h(MAX).min_h(0)
        .when(!list.length, (el) => el.child(div().p(8).text_color(t.dim).child(this.query ? "Nothing matches" : "No other running sessions")))
        .children(list.slice(start, start + fit).map((x, i) => {
          const index = start + i;
          const [project, task, session] = x.parts;
          const label = h_flex().flex_1().min_w(0).gap(6).items_center()
            .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.muted).child(project))
            .when(Boolean(task), (el) => el.child(sep()).child(div().flex_shrink(1).min_w(0).truncate().text_color(t.foreground).child(task)))
            .when(Boolean(session), (el) => el.child(sep()).child(div().flex_shrink(0).max_w(140).truncate().text_color(t.muted).child(session)));
          const note = x.status === "blocked" ? ["needs you", t.blocked] : x.status === "done" ? ["done", t.done] : x.at ? [ago(x.at), t.dim] : null;
          return h_flex().id(`sr-sw-${index}`).h(ROW).flex_none().px(10).gap(9).rounded(7).items_center()
            .when(index === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.pick(x))
            .child(statusGlyph(t, x.status))
            .child(label)
            .when(Boolean(note), (el) => el.child(div().flex_none().text_size(11).text_color(note[1]).child(note[0])));
        })));
  }
}

// How long ago, shortly: "now", "5m", "3h", "2d".
function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

// Case-insensitive subsequence match, as the TUI's picker: lower is better.
function fuzzy(query, candidate) {
  const q = query.toLowerCase();
  if (!q) return 0;
  const c = candidate.toLowerCase();
  let ci = 0, first = -1, prev = -1, gaps = 0;
  for (const ch of q) {
    const found = c.indexOf(ch, ci);
    if (found < 0) return null;
    if (first < 0) first = found;
    if (prev >= 0) gaps += found - prev - 1;
    prev = found;
    ci = found + 1;
  }
  return first * 100 + gaps * 10 + c.length;
}

// Asks before something destructive, as the TUI's y/n prompts do.
export class Confirm {
  init(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  yes() {
    const p = props();
    close({ kind: "act", label: p.label ?? "Working", args: p.args, opts: { timeout: 300000 } });
  }

  render() {
    const t = theme();
    const p = props();
    const danger = (p.args ?? []).includes("--yes");
    return v_flex().id("sr-confirm").track_focus(this.handle).w_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key.length === 1 ? e.key_char ?? e.key : e.key;
        if (e.key === "enter" || k === "y") this.yes();
        else if (e.key === "escape" || k === "n") close();
        else return;
        cx.stop_propagation();
      })
      .child(title(t, p.title, "y / n"))
      .child(div().text_color(t.muted).child(p.detail ?? ""))
      .child(h_flex().pt(6).gap(8).justify_end()
        .child(button(t, "sr-no", "Cancel", false, () => close()))
        .child(button(t, "sr-yes", p.label ?? "Confirm", !danger, () => this.yes(), danger)));
  }
}
