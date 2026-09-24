// Test stand-in for the `mermaid` package: no layout engine in jsdom, so
// render() returns a marker SVG for well-formed input and throws a
// Mermaid-shaped parse error for any source containing "INVALID". Tests read
// `calls` to check how often, and with which ids, the document reader asks
// for a render.
export const calls = [];
export let config = null;

const api = {
    initialize(next) {
        config = next;
        api.config = next;
    },
    async render(id, source) {
        calls.push({ id, source });
        if (/INVALID/.test(source)) {
            throw new Error(`Parse error on line 2:\n${source.split("\n")[1] || ""}\n^\nExpecting 'NEWLINE', got 'INVALID'`);
        }
        const title = source.split("\n")[0];
        return { svg: `<svg id="${id}" data-stub-mermaid="" xmlns="http://www.w3.org/2000/svg" width="200" height="40"><text x="0" y="20">${title}</text></svg>` };
    },
};

export default api;
