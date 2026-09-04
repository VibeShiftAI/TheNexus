// Module loader hooks for the dashboard's node:test suite.
//
// Lets node:test import the real .tsx/.ts component sources (esbuild
// transform), resolves the `@/` tsconfig alias and extensionless relative
// imports, and swaps a small fixed set of modules for test stubs:
//   - @/components/cortex-provider → a controllable useCortex() store
//   - @/lib/active-client          → no-network presence stubs
//   - @/lib/normalizeMarkdown      → real impl + render/parse counter
//   - @/lib/task-links             → real impl + splitOnTaskIds counter
//   - next/link, next/navigation   → minimal standalone stand-ins
//   - socket.io-client             → inspectable fake `io()` (no network)
// The counting stubs delegate to the real implementations — they exist so
// tests can assert HOW OFTEN the markdown pipeline runs, which is the whole
// point of the ai-terminal render-isolation suite.
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync } from "esbuild";

const SRC_ROOT = new URL("../src/", import.meta.url);
const STUB_ROOT = new URL("./stubs/", import.meta.url);

const STUBS = new Map([
    ["@/components/cortex-provider", new URL("cortex-provider.mjs", STUB_ROOT).href],
    ["@/lib/active-client", new URL("active-client.mjs", STUB_ROOT).href],
    ["@/lib/normalizeMarkdown", new URL("normalize-markdown.mjs", STUB_ROOT).href],
    ["@/lib/task-links", new URL("task-links.mjs", STUB_ROOT).href],
    ["next/link", new URL("next-link.mjs", STUB_ROOT).href],
    ["next/navigation", new URL("next-navigation.mjs", STUB_ROOT).href],
    // No network in tests: an inspectable fake socket (see stubs/socket-io-client.mjs).
    ["socket.io-client", new URL("socket-io-client.mjs", STUB_ROOT).href],
]);

const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", "/index.ts", "/index.tsx"];

function tryExtensions(baseUrl) {
    for (const ext of EXTENSIONS) {
        const candidate = `${baseUrl.href}${ext}`;
        try {
            const path = fileURLToPath(candidate);
            if (fs.existsSync(path) && fs.statSync(path).isFile()) {
                return pathToFileURL(path).href;
            }
        } catch {
            /* invalid URL for this extension — keep trying */
        }
    }
    return null;
}

export async function resolve(specifier, context, nextResolve) {
    const stub = STUBS.get(specifier);
    if (stub) return { url: stub, shortCircuit: true };

    if (specifier.startsWith("@/")) {
        const resolved = tryExtensions(new URL(specifier.slice(2), SRC_ROOT));
        if (resolved) return { url: resolved, shortCircuit: true };
    }

    try {
        return await nextResolve(specifier, context);
    } catch (err) {
        // Bundler-style directory imports inside packages
        // (react-syntax-highlighter/dist/esm/styles/prism → …/index.js).
        if (err?.code === "ERR_UNSUPPORTED_DIR_IMPORT" && err.url) {
            const resolved = tryExtensions(new URL(`${err.url}/index`, "file:"));
            if (resolved) return { url: resolved, shortCircuit: true };
        }
        // Extensionless relative imports (`../calendar`) used by existing
        // src tests — resolve them against the importing file.
        if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
            const resolved = tryExtensions(new URL(specifier, context.parentURL));
            if (resolved) return { url: resolved, shortCircuit: true };
        }
        throw err;
    }
}

export async function load(url, context, nextLoad) {
    if (url.startsWith("file:") && /\.(ts|tsx|mts)$/.test(url)) {
        const path = fileURLToPath(url);
        const source = fs.readFileSync(path, "utf8");
        const { code } = transformSync(source, {
            loader: url.endsWith(".tsx") ? "tsx" : "ts",
            jsx: "automatic",
            format: "esm",
            target: "es2022",
            sourcefile: path,
            sourcemap: "inline",
        });
        return { format: "module", source: code, shortCircuit: true };
    }
    return nextLoad(url, context);
}
