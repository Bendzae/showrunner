// Showrunner in Herdr: the sidebar tree (default), and the popups it opens
// (props.view: "menu", "form", "picker", "confirm").

import { View } from "gpui-kit";
import { props } from "herdr";
import { Tree } from "./tree.js";
import { Menu, Form, Picker, Confirm } from "./overlays.js";

const VIEWS = { tree: Tree, menu: Menu, form: Form, picker: Picker, confirm: Confirm };

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
