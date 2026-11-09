import { render } from "preact";
import { html } from "htm/preact";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/fraunces/wght-italic.css";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { App } from "./components/App.js";

render(html`<${App} />`, document.getElementById("root"));
