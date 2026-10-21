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
// PDF.js uses a same-origin worker and local decoding/font data; no PDF browser plug-in.
const pdfRoot = path.join(root, 'node_modules/pdfjs-dist');
await fs.copyFile(path.join(pdfRoot, 'legacy/build/pdf.worker.mjs'), path.join(out, 'pdf.worker.js'));
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  for (const file of await fs.readdir(path.join(pdfRoot, directory))) {
    if (!/\.(?:bcmap|pfb|ttf|wasm|js)$/.test(file) || file.startsWith('quickjs')) continue;
    await fs.copyFile(path.join(pdfRoot, directory, file), path.join(out, file));
  }
}
await fs.copyFile(path.join(pdfRoot, 'LICENSE'), path.join(out, 'PDFJS-LICENSE.txt'));
await fs.copyFile(path.join(root, 'src/app/icon.png'), path.join(out, 'icon.png'));
const sdk = 'https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/';
for (const cast of [false, true]) {
  const csp = `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'${cast ? ` ${sdk}` : ''}; style-src 'self' 'unsafe-inline'; connect-src 'self' blob:${cast ? ' ws://localhost:8008/v2/ipc' : ''}; img-src 'self' blob: data:; media-src blob:; worker-src 'self' blob:; frame-src 'none'; font-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'`;
  await fs.writeFile(path.join(out, cast ? 'cast.html' : 'index.html'), `<!doctype html><html lang="en"${cast ? ' data-nexus-receiver="cast"' : ''}><head><meta charset="utf-8"><meta name="nexus-presentation" content="1"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Nexus presentation</title><link rel="icon" type="image/png" href="/presentation/icon.png"><link rel="stylesheet" href="/presentation/app.css">${cast ? `<script src="${sdk}cast_receiver_framework.js"></script>` : ''}</head><body><div id="presentation"></div><script type="module" src="/presentation/app.js"></script></body></html>\n`, 'utf8');
}
console.log('Built isolated presentation renderer in dashboard/public/presentation');
