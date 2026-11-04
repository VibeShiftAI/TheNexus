import React from "react";
import Markdown from "../../node_modules/react-markdown/index.js";
export default function CountedMarkdown(props) {
  globalThis.__documentMarkdownParses =
    (globalThis.__documentMarkdownParses ?? 0) + 1;
  return React.createElement(Markdown, props);
}
