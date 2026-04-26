import http from "node:http";
import https from "node:https";
import { loadConfig } from "./config.mjs";
import { getOidcClient } from "./client.mjs";
import { registerRoutes } from "./routes.mjs";
import { log } from "./log.mjs";

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 60_000;

let capturedApp = null;
let capturedServer = null;

function isExpressApp(fn) {
  return (
    typeof fn === "function" &&
    typeof fn.use === "function" &&
    typeof fn.get === "function" &&
    typeof fn.post === "function" &&
    (typeof fn.handle === "function" || typeof fn.lazyrouter === "function" || fn._router !== undefined || fn.router !== undefined)
  );
}

function hookCreateServer() {
  const wrap = (mod) => {
    const orig = mod.createServer;
    if (!orig || orig.__oidc_wrapped__) return;
    const wrapped = function (...args) {
      for (const a of args) {
        if (isExpressApp(a)) {
          if (!capturedApp) {
            capturedApp = a;
            log.info(`Express app captured via ${mod === http ? "http" : "https"}.createServer hook`);
          }
          break;
        }
      }
      const server = orig.apply(this, args);
      if (!capturedServer) capturedServer = server;
      return server;
    };
    Object.defineProperty(wrapped, "__oidc_wrapped__", { value: true });
    Object.defineProperty(mod, "createServer", {
      configurable: true,
      writable: true,
      value: wrapped,
    });
  };
  wrap(http);
  wrap(https);
}

function scanGlobals() {
  const probes = [
    () => globalThis.config?.express,
    () => globalThis.config?.app,
    () => globalThis.express,
    () => globalThis.app,
  ];
  for (const p of probes) {
    try {
      const v = p();
      if (isExpressApp(v)) return v;
    } catch {}
  }
  return null;
}

function scanActiveHandles() {
  try {
    const handles = process._getActiveHandles?.() ?? [];
    for (const h of handles) {
      if (!h) continue;
      let listeners = null;
      try {
        listeners = h.listeners?.("request");
      } catch {}
      if (Array.isArray(listeners)) {
        for (const l of listeners) {
          if (isExpressApp(l)) return l;
        }
      }
    }
  } catch (e) {
    log.debug(`scanActiveHandles error: ${e.message}`);
  }
  return null;
}

function locateExpressApp() {
  if (capturedApp) return capturedApp;
  const fromGlobals = scanGlobals();
  if (fromGlobals) return fromGlobals;
  const fromHandles = scanActiveHandles();
  if (fromHandles) return fromHandles;
  return null;
}

function waitForExpressApp() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const app = locateExpressApp();
      if (app) return resolve(app);
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        return reject(
          new Error(
            `timed out after ${POLL_TIMEOUT_MS}ms locating Foundry Express app. ` +
              `Tried http.createServer hook, globalThis probes, and process._getActiveHandles scan. ` +
              `Set OIDC_DEBUG=1 and inspect logs for diagnostic dumps.`,
          ),
        );
      }
      const t = setTimeout(tick, POLL_INTERVAL_MS);
      if (typeof t.unref === "function") t.unref();
    };
    tick();
  });
}

function isLikelyFoundryServerProcess() {
  const argv1 = process.argv[1] || "";
  return /main\.mjs$/i.test(argv1) || /resources\/app/i.test(argv1);
}

function dumpDiagnostics() {
  try {
    const handles = process._getActiveHandles?.() ?? [];
    const summary = handles.slice(0, 20).map((h, i) => {
      try {
        return {
          i,
          ctor: h?.constructor?.name,
          reqListeners: h?.listeners?.("request")?.length,
        };
      } catch {
        return { i, err: "introspection failed" };
      }
    });
    log.info("active handles:", JSON.stringify(summary));
    log.info(
      "globalThis keys (truncated):",
      Object.keys(globalThis).slice(0, 50).join(","),
    );
    if (globalThis.config) {
      log.info(
        "globalThis.config keys:",
        Object.keys(globalThis.config).slice(0, 30).join(","),
      );
    }
  } catch (e) {
    log.error(`diagnostics dump failed: ${e.message}`);
  }
}

async function bootstrap() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    log.error(err.message);
    log.warn("OIDC shim disabled. Foundry will continue to boot normally.");
    return;
  }

  if (!isLikelyFoundryServerProcess()) {
    log.debug(
      `not the Foundry server process (argv[1]=${process.argv[1]}); shim idle`,
    );
    return;
  }

  hookCreateServer();
  log.debug("http/https createServer hooks installed");

  try {
    await getOidcClient(cfg);
  } catch (err) {
    log.error(`issuer discovery failed: ${err.message}`);
    log.warn(
      "Continuing to wait for Foundry to start; will retry discovery on first request.",
    );
  }

  let app;
  try {
    app = await waitForExpressApp();
  } catch (err) {
    log.error(err.message);
    if (cfg.debug) dumpDiagnostics();
    return;
  }

  log.info(`Express app located. has _router=${!!app._router}`);

  try {
    registerRoutes(app, cfg);
    log.info("OIDC shim active.");
  } catch (err) {
    log.error("route registration failed:", err);
  }
}

bootstrap().catch((err) => {
  log.error("unexpected bootstrap failure:", err);
});
