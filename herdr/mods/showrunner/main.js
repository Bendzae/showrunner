// Showrunner in Herdr: the sidebar tree (default), the popups it opens
// (props.view: "menu", "form", "picker", "confirm", "switcher"), the right panel's
// views ("pr", "ticket", "ideas") and their buttons in the top bar ("bar").

import { View } from "gpui-kit";
import { props } from "herdr";
import { Tree } from "./tree.js";
import { Menu, Form, Picker, Confirm, Switcher } from "./overlays.js";
import { PrPanel, TicketPanel, IdeasPanel, PanelBar } from "./panels.js";

const VIEWS = { tree: Tree, menu: Menu, form: Form, picker: Picker, confirm: Confirm, switcher: Switcher, pr: PrPanel, ticket: TicketPanel, ideas: IdeasPanel, bar: PanelBar };

export default class Showrunner extends View {
  init(_props, cx) {
    const View = VIEWS[props()?.view ?? "tree"] ?? Tree;
    this.view = new View();
    this.view.init(cx);
  }

  render(cx) {
    return this.view.render(cx);
  }
}
