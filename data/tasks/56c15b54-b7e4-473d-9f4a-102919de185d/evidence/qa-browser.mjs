import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const evidence = dirname(fileURLToPath(import.meta.url));
if (existsSync(resolve(process.cwd(), '.next-verify-ops'))) throw new Error('Refusing to overwrite an existing verification build');
const log = createWriteStream(resolve(evidence, 'qa-browser.log'));
const child = spawn(process.execPath, ['scripts/ops-graphic-browser-check.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, CHECK_LABEL: 'qa', CHECK_OUT: evidence },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
await new Promise(resolve => log.end(resolve));
process.exit(code ?? 1);
