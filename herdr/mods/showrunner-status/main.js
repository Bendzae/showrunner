// The status bar: what the tree has selected (where it is, its branch and
// base, PR, Linear ticket, diff) and the operations running, as the TUI's
// bottom line does.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { shared, theme, agents } from "herdr";

const ICON = (name) => `mods/showrunner/icons/${name}.svg`;

export default class ShowrunnerStatus extends View {
  render() {
    const t = theme();
    const s = shared("showrunner.selected");
    const busy = shared("showrunner.busy") ?? [];
    const needs = agents().filter((a) => a.status === "blocked").length;
    const item = (iconName, text, color) => h_flex().flex_none().gap(5).items_center().text_color(color ?? t.muted)
      .when(Boolean(iconName), (el) => el.child(svg(ICON(iconName)).size(12)))
      .child(text);
    const hint = (k, text) => h_flex().gap(4).items_center()
      .child(div().px(4).h(16).flex().items_center().rounded(4).border_1().border_color(t.input).text_size(10.5).text_color(t.muted).child(k))
      .child(text);
    return h_flex().size_full().min_w(0).px(14).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(11.8).text_color(t.muted)
      .when(Boolean(s), (el) => el
        .child(h_flex().flex_shrink(1).min_w(0).gap(5).items_center()
          .children(s.crumbs.flatMap((c, i) => [
            ...(i ? [div().text_color(t.dim).child("›")] : []),
            div().truncate().text_color(i === s.crumbs.length - 1 ? t.foreground : t.muted).child(c),
          ])))
        .when(s.status === "blocked", (el) => el.child(item(null, "needs you", t.blocked)))
        .when(s.status === "stopped", (el) => el.child(item(null, s.inTmux ? "in tmux · showrunner migrate moves it here" : "stopped · ↵ starts it", t.dim)))
        .when(Boolean(s.branch), (el) => el.child(item("git-branch", s.base && s.base !== s.branch ? `${s.branch} → ${s.base}` : s.branch)))
        .when(Boolean(s.pr), (el) => el.child(item(null, s.pr)))
        .when(Boolean(s.linear), (el) => el.child(item(null, s.linear)))
        .when(Boolean(s.diff && (s.diff.added || s.diff.removed)), (el) => el.child(h_flex().flex_none().gap(4)
          .child(div().text_color(t.ansi2).child(`+${s.diff.added}`))
          .child(div().text_color(t.ansi1).child(`−${s.diff.removed}`)))))
      .child(div().flex_1())
      .when(needs > 0, (el) => el.child(item(null, `${needs} need${needs === 1 ? "s" : ""} you`, t.blocked)))
      .when(busy.length > 0, (el) => el.child(h_flex().flex_none().gap(6).items_center().text_color(t.foreground)
        .child(svg(ICON("spinner")).size(12).text_color(t.working).spin(900))
        .child(`${busy[busy.length - 1]}…`)))
      .when(!busy.length, (el) => el.child(h_flex().flex_none().gap(12).items_center().text_color(t.dim)
        .child(hint("a", "actions"))
        .child(hint("/", "filter"))
        .child(hint("⌃/", "tree ⇄ terminal"))
        .child(hint("⌃'", "panels"))));
  }
}
