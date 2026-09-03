// Warn when the installed @praxis/contract copy is behind its source checkout.
//
// The dashboard installs @praxis/contract from ../../nexus-shared as a real copy
// (install-links=true in ./.npmrc) and a plain `npm install` never refreshes
// it. Runs as `predev`/`prebuild`; it only warns (exit 0) so a supervised
// `npm run dev` restart is never blocked by a stale copy.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dashboardDir, "..", "..", "nexus-shared");
const installed = resolve(dashboardDir, "node_modules/@praxis/contract/dist/index.js");
const source = resolve(sourceDir, "dist/index.js");

if (!existsSync(source)) process.exit(0); // no source checkout here: nothing to compare
if (!existsSync(installed)) {
  console.warn(`[contract-freshness] @praxis/contract is not installed; run \`npm install\` in ${dashboardDir}`);
  process.exit(0);
}
if (!readFileSync(installed).equals(readFileSync(source))) {
  console.warn(
    `[contract-freshness] WARNING: node_modules/@praxis/contract/dist is out of date versus ${source}.\n` +
      `  The dashboard is compiling against stale contract schemas. Refresh with:\n` +
      `  cd ${dashboardDir} && rm -rf node_modules/@praxis && npm install`,
  );
}
