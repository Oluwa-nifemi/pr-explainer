import { render } from "preact";
import { html } from "htm/preact";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/fraunces/wght-italic.css";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { ExportPage } from "./components/App.js";
import { prepareStory } from "./lib/prepare.js";

const story = globalThis.__PRX_EXPORT__;

render(html`<${ExportPage} story=${story && prepareStory(story)} />`, document.getElementById("root"));
