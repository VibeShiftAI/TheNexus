// Preloaded into test processes (NODE_OPTIONS=--import): refuses and records any
// request that would leave this machine, and any request to a live local service
// (LM Studio 1234, dashboard 3000, Nexus API 4000, Cortex 8100, Praxis 54322,
// plus the 3777 and 4199 servers already running here). Tests' own listeners
// bind 127.0.0.1 on port 0, so loopback on any other port stays allowed.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const LOG = process.env.NET_GUARD_LOG;
const LIVE_PORTS = new Set(["1234", "3000", "3777", "4000", "4199", "8100", "54322"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function verdict(host, port) {
  const h = String(host || "").toLowerCase();
  if (!LOOPBACK.has(h)) return `non-loopback host ${h}`;
  if (LIVE_PORTS.has(String(port))) return `live local port ${port}`;
  return null;
}

function record(kind, target, why) {
  const stack = (new Error().stack || "").split("\n").filter((l) => l.includes("/server/") || l.includes("/db/") || l.includes("/services/")).slice(0, 5).join(" | ");
  if (LOG) fs.appendFileSync(LOG, `${process.pid} ${kind} ${target} (${why}) :: ${stack}\n`);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const raw = input instanceof Request ? input.url : String(input);
  let u;
  try { u = new URL(raw); } catch { return realFetch(input, init); }
  const why = verdict(u.hostname, u.port || (u.protocol === "https:" ? "443" : "80"));
  if (why) {
    record(`fetch ${(init && init.method) || "GET"}`, `${u.protocol}//${u.host}${u.pathname}`, why);
    throw new TypeError(`fetch failed (network guard refused ${u.protocol}//${u.host}${u.pathname})`);
  }
  return realFetch(input, init);
};

function wrap(mod, name, defaultPort) {
  const real = mod[name];
  mod[name] = function guarded(...args) {
    let host; let port; let path = "";
    const first = args[0];
    if (typeof first === "string" || first instanceof URL) {
      const u = new URL(String(first));
      host = u.hostname; port = u.port || defaultPort; path = u.pathname;
      const opts = args[1] && typeof args[1] === "object" ? args[1] : null;
      if (opts && (opts.hostname || opts.host)) host = opts.hostname || opts.host;
      if (opts && opts.port) port = opts.port;
    } else if (first && typeof first === "object") {
      host = first.hostname || first.host || "localhost";
      port = first.port || defaultPort; path = first.path || "";
      if (first.socketPath) return real.apply(this, args);
    }
    const why = verdict(String(host).replace(/:\d+$/, ""), port);
    if (why) {
      record(`${mod === https ? "https" : "http"}.${name}`, `${host}:${port}${path.split("?")[0]}`, why);
      throw new Error(`network guard refused ${host}:${port}`);
    }
    return real.apply(this, args);
  };
}
wrap(http, "request", "80");
wrap(http, "get", "80");
wrap(https, "request", "443");
wrap(https, "get", "443");
