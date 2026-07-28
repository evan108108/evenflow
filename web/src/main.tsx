import { render } from "solid-js/web";
import "@fontsource-variable/bodoni-moda";
import "@fontsource-variable/dm-sans";
import "./lib/theme.css";
import { App } from "./App";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");

render(() => <App />, root);
