// Preloaded into test processes (NODE_OPTIONS=--import) for the wider Praxis
// regression run: refuses and records every TCP connection to a host off this
// machine, and every loopback connection to a port that was already listening
// when the run started (LIVE_PORTS_FILE, one port per line, taken with lsof just
// before the run). A test's own server binds a port after that snapshot, so its
// loopback traffic stays allowed. The check sits on net.Socket's connect, which
// http, https, fetch and database drivers all go through. A refused connection
// fails the way a closed port does: the socket is destroyed with an error.
import fs from "node:fs";
import net from "node:net";

const LOG = process.env.LIVE_PORT_GUARD_LOG;
const LIVE = new Set(
  fs.readFileSync(process.env.LIVE_PORTS_FILE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean),
);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]);

function verdict(host, port) {
  const h = String(host || "localhost").toLowerCase();
  if (!LOOPBACK.has(h)) return `host off this machine (${h})`;
  if (LIVE.has(String(port))) return `port ${port} was listening before the run`;
  return null;
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  let host;
  let port;
  if (first && typeof first === "object") {
    if (first.path) return realConnect.apply(this, args);
    port = first.port;
    host = first.host || first.hostname || "localhost";
  } else if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    port = first;
    host = typeof args[1] === "string" ? args[1] : "localhost";
  } else {
    return realConnect.apply(this, args);
  }
  const why = verdict(host, port);
  if (!why) return realConnect.apply(this, args);
  if (LOG) {
    const where = (new Error().stack || "").split("\n").filter((l) => l.includes("/tests/") || l.includes("/src/")).slice(0, 4).join(" | ");
    fs.appendFileSync(LOG, `${process.pid} connect ${host}:${port} (${why}) :: ${process.argv.slice(1).join(" ")} :: ${where}\n`);
  }
  const err = Object.assign(new Error(`live port guard refused ${host}:${port}`), { code: "ECONNREFUSED" });
  process.nextTick(() => this.destroy(err));
  return this;
};
