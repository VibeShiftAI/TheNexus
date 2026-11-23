import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const evidence = dirname(fileURLToPath(import.meta.url));
if (process.argv[2] === 'environment') {
  console.log(JSON.stringify({node: process.version, platform: process.platform, arch: process.arch, lock: createHash('sha256').update(readFileSync('package-lock.json')).digest('hex'), packages: Object.fromEntries(['typescript','react','react-dom','jsdom','esbuild'].map(name => [name, JSON.parse(readFileSync(resolve('node_modules',name,'package.json'),'utf8')).version]))}));
} else {
  const result = spawnSync('npm', ['test'], {encoding:'utf8', maxBuffer:64*1024*1024});
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const label = process.cwd().includes('/proof-baselines/') ? 'baseline' : 'candidate';
  writeFileSync(resolve(evidence, `qa-dashboard-${label}.log`), output);
  console.log(output.split('\n').filter(line => /^[✖ℹ]/.test(line)).join('\n'));
  console.log(`Process exit: ${result.status}; signal: ${result.signal}; error: ${result.error ?? 'none'}`);
  process.exit(result.status ?? 1);
}
