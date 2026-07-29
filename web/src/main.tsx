import { render } from "solid-js/web";
// The opsz variant, not the default wght-only cut: Bodoni Moda's display
// look lives on its optical-size axis (checked: the family ships no ss01
// stylistic set), so headings pick up the high-contrast Didone hairlines
// automatically via font-optical-sizing.
import "@fontsource-variable/bodoni-moda/opsz.css";
import "@fontsource-variable/dm-sans";
import "./lib/theme.css";
import { App } from "./App";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");

render(() => <App />, root);
