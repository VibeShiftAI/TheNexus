// Preloaded into every test process (NODE_OPTIONS=--import): refuses and records
// any fetch to an LM Studio on this machine (port 1234) or the dead test port 1.
import fs from "node:fs";
const LOG = process.env.LMSTUDIO_GUARD_LOG;
const real = globalThis.fetch;
const blocked = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):(1234|1)(\/|$)/.test(u);
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (blocked(url)) {
    const where = (new Error().stack || "").split("\n").filter((l) => l.includes("/tests/") || l.includes("/src/")).slice(0, 6).join(" | ");
    if (LOG) fs.appendFileSync(LOG, `${process.pid} ${(init && init.method) || "GET"} ${url} :: ${process.argv.slice(1).join(" ")} :: ${where}\n`);
    throw new TypeError(`fetch failed (LM Studio guard refused ${url})`);
  }
  return real(input, init);
};
