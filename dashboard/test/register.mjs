// --import entry for the dashboard's node:test suite: installs the esbuild
// loader (TSX + `@/` alias + stubs, see loader-hooks.mjs) and a jsdom DOM so
// React components can mount for real. Run via `npm test` in dashboard/.
import { register } from "node:module";
import { JSDOM } from "jsdom";

register(new URL("./loader-hooks.mjs", import.meta.url));

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
});
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

// DOM constructors and APIs components reach for via bare globals. Node's own
// Blob/File/FormData/URL/fetch stay in place — they interoperate and node's
// URL.createObjectURL actually works with node Blobs.
for (const key of [
    "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLAudioElement",
    "Element", "Node", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent",
    "MutationObserver", "getComputedStyle", "localStorage", "sessionStorage",
    "requestAnimationFrame", "cancelAnimationFrame",
]) {
    if (window[key] !== undefined && globalThis[key] === undefined) {
        globalThis[key] = window[key];
    }
}

// jsdom has no layout engine — scroll APIs are inert but must exist.
if (!window.Element.prototype.scrollTo) {
    window.Element.prototype.scrollTo = function scrollTo() {};
}

// React act() support for the component tests.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
