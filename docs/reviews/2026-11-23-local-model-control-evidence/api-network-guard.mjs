// Preloaded into the throwaway Nexus API of local-model-browser-check.mjs
// (node --import): refuses, and logs to NET_GUARD_LOG, every connection that
// would leave this machine or reach a live local service: LM Studio 1234, the
// dashboard 3000, the Nexus API 4000, Cortex 8100, Praxis 54322, and the 3777
// and 4199 servers already running on this machine. The check's own fakes
// listen on 127.0.0.1 at OS-assigned ports, so loopback on any other port
// stays allowed. Covers fetch, http(s).request/get and net/tls connects.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const LOG = process.env.NET_GUARD_LOG;
const LIVE_PORTS = new Set(["1234", "3000", "3777", "4000", "4199", "8100", "54322"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function verdict(host, port) {
  const h = String(host || "localhost").toLowerCase().replace(/^\[|\]$/g, "");
  if (!LOOPBACK.has(h) && h !== "::1") return `non-loopback host ${h}`;
  if (LIVE_PORTS.has(String(port))) return `live local port ${port}`;
  return null;
}

function record(kind, target, why) {
  const stack = (new Error().stack || "").split("\n").filter((l) => /\/(server|db|services)\//.test(l)).slice(0, 4).map((l) => l.trim()).join(" | ");
  if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), kind, target, why, stack })}\n`);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const raw = input instanceof Request ? input.url : String(input);
  let u;
  try { u = new URL(raw); } catch { return realFetch(input, init); }
  const why = verdict(u.hostname, u.port || (u.protocol === "https:" ? "443" : "80"));
  if (why) {
    record(`fetch ${(init && init.method) || (input instanceof Request ? input.method : "GET")}`, `${u.protocol}//${u.host}${u.pathname}`, why);
    throw new TypeError(`fetch failed (network guard refused ${u.protocol}//${u.host}${u.pathname})`);
  }
  return realFetch(input, init);
};

function wrapRequest(mod, name, defaultPort) {
  const real = mod[name];
  mod[name] = function guarded(...args) {
    let host; let port; let pathname = "";
    const first = args[0];
    if (typeof first === "string" || first instanceof URL) {
      const u = new URL(String(first));
      host = u.hostname; port = u.port || defaultPort; pathname = u.pathname;
      const opts = args[1] && typeof args[1] === "object" ? args[1] : null;
      if (opts && (opts.hostname || opts.host)) host = opts.hostname || opts.host;
      if (opts && opts.port) port = opts.port;
    } else if (first && typeof first === "object") {
      if (first.socketPath) return real.apply(this, args);
      host = first.hostname || first.host || "localhost";
      port = first.port || defaultPort; pathname = first.path || "";
    }
    const why = verdict(String(host).replace(/:\d+$/, ""), port);
    if (why) {
      record(`${mod === https ? "https" : "http"}.${name}`, `${host}:${port}${String(pathname).split("?")[0]}`, why);
      throw new Error(`network guard refused ${host}:${port}`);
    }
    return real.apply(this, args);
  };
}
wrapRequest(http, "request", "80");
wrapRequest(http, "get", "80");
wrapRequest(https, "request", "443");
wrapRequest(https, "get", "443");

function wrapConnect(mod, name, label) {
  const real = mod[name];
  mod[name] = function guarded(...args) {
    const first = args[0];
    let host = "localhost"; let port = null;
    if (first && typeof first === "object") {
      if (first.path) return real.apply(this, args);
      host = first.host || first.hostname || "localhost"; port = first.port;
    } else if (typeof first === "number" || /^\d+$/.test(String(first))) {
      port = first; host = typeof args[1] === "string" ? args[1] : "localhost";
    } else {
      return real.apply(this, args); // a local socket path
    }
    const why = verdict(host, port);
    if (why) {
      record(`${label}.${name}`, `${host}:${port}`, why);
      throw new Error(`network guard refused ${host}:${port}`);
    }
    return real.apply(this, args);
  };
}
wrapConnect(net, "connect", "net");
wrapConnect(net, "createConnection", "net");
wrapConnect(tls, "connect", "tls");
