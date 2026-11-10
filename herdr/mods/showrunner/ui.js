// Shared look: Herdr's own status language (spinner, needs-you, done dot),
// the TUI's PR / CI / diff badges, and project avatars.

import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";

export const ICON = (name) => `mods/showrunner/icons/${name}.svg`;

export function icon(name, size, color) {
  const el = svg(ICON(name)).size(size).flex_none();
  return color ? el.text_color(color) : el;
}

// A program's icon from Herdr's program table: a one-color glyph or a picture.
export function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// One cell, the same width for every status, so names line up.
export function statusGlyph(t, status, size = 12) {
  const cell = h_flex().w(size + 2).h(size + 2).flex_none().items_center().justify_center();
  switch (status) {
    case "working":
      return cell.child(svg(ICON("spinner")).size(size).text_color(t.working).spin(900));
    case "blocked":
      return cell.child(h_flex().size(size + 2).rounded(4).bg(t.blocked).items_center().justify_center()
        .text_size(size - 2).font_bold().text_color(t.background).child("!"));
    case "done":
      return cell.child(div().size(7).rounded(4).bg(t.done));
    case "idle":
      return cell.child(div().size(7).rounded(4).border_1().border_color(t.idle));
    case "stopped":
      return cell.child(div().size(7).rounded(4).border_1().border_color(t.dim).opacity(0.6));
    default:
      return cell.child(div().size(3).rounded(2).bg(t.dim));
  }
}

export const prNumber = (url) => url?.split("/").pop() ?? "";

// One color for a PR, what matters most first: it's done, CI failed or
// changes were asked for, CI runs, it's approved, it waits for review.
export function prColor(t, pr) {
  if (pr.state === "merged") return t.ansi5;
  if (pr.state === "closed") return t.dim;
  if (pr.state === "draft") return t.muted;
  if (pr.checks === "failing" || pr.review === "changes_requested") return t.ansi1;
  if (pr.checks === "pending") return t.ansi3;
  if (pr.review === "approved") return t.ansi2;
  return t.accent;
}

export function prSummary(pr) {
  if (!pr) return null;
  const parts = [`PR #${prNumber(pr.url)} ${pr.state}`];
  if (pr.state === "open" || pr.state === "draft") {
    parts.push({ approved: "approved", changes_requested: "changes requested", requested: "review requested", not_requested: "no reviewers" }[pr.review] ?? pr.review);
    if (pr.checks) parts.push(`CI ${pr.checks}`);
  }
  return parts.join(" · ");
}

// How many sessions under a folded row wait for input, work, or are done:
// `! 1  ⟳ 2  ● 1`. Null when none do.
export function activityBadge(t, a) {
  if (!a || !(a.blocked || a.working || a.done)) return null;
  return h_flex().flex_none().gap(6).items_center().text_size(11)
    .when(a.blocked > 0, (el) => el.child(h_flex().h(15).px(4).rounded(4).bg(t.blocked).items_center()
      .font_bold().text_color(t.background).child(`! ${a.blocked}`)))
    .when(a.working > 0, (el) => el.child(h_flex().gap(3).items_center().text_color(t.working)
      .child(svg(ICON("spinner")).size(10).spin(900)).child(String(a.working))))
    .when(a.done > 0, (el) => el.child(h_flex().gap(3).items_center().text_color(t.done)
      .child(div().size(6).rounded(3).bg(t.done)).child(String(a.done))));
}

// 1234 → 1.2k, 12345 → 12k.
export function short(n) {
  if (n < 1000) return String(n);
  return n < 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(n / 1000)}k`;
}

export function diffBadge(t, diff) {
  if (!diff || (!diff.added && !diff.removed)) return null;
  return h_flex().flex_none().gap(2).text_size(11)
    .child(div().text_color(diff.added ? t.ansi2 : t.dim).child(`+${short(diff.added)}`))
    .child(div().text_color(diff.removed ? t.ansi1 : t.dim).child(`−${short(diff.removed)}`));
}

// One strong color per hue, light and dark alike (as Herdr's space avatars).
const MARK = ["#22a99a", "#e3814f", "#5b8def", "#8b7cf6", "#3fae6a", "#d9649a"];
export function avatarColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return MARK[h % MARK.length];
}

export function avatar(name, size = 18) {
  return h_flex().size(size).flex_none().rounded(5).bg(avatarColor(name)).items_center().justify_center()
    .text_size(size * 0.58).font_bold().text_color("#ffffff").child([...name][0]?.toUpperCase() ?? "?");
}

// A key as the TUI shows it in menus and hints.
export function keycap(t, key, on) {
  return h_flex().h(18).min_w(18).px(4).flex_none().rounded(4).border_1().border_color(on ? t.accent : t.input)
    .items_center().justify_center().text_size(11).font_semibold().text_color(on ? t.foreground : t.muted).child(key === " " ? "␣" : key);
}

export function linearId(url) {
  return /\/issue\/([A-Za-z]+-\d+)/.exec(url ?? "")?.[1]?.toUpperCase() ?? null;
}
