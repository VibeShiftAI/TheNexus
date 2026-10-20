// Standalone static renderer: no Next root providers or authenticated cockpit chrome on a receiver.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public/presentation');
await fs.mkdir(out, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['src/presentation/entry.tsx'], outdir: out, entryNames: 'app', bundle: true, splitting: true, format: 'esm', target: ['es2020'], minify: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });
const source = path.join(root, 'src/presentation/styles.css');
const css = await postcss([tailwind()]).process(await fs.readFile(source, 'utf8'), { from: source });
await fs.writeFile(path.join(out, 'app.css'), css.css, 'utf8');
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' blob: data:; media-src blob:; frame-src blob:; font-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";
await fs.writeFile(path.join(out, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Nexus presentation</title><link rel="stylesheet" href="/presentation/app.css"></head><body><div id="presentation"></div><script type="module" src="/presentation/app.js"></script></body></html>\n`, 'utf8');
console.log('Built isolated presentation renderer in dashboard/public/presentation');
