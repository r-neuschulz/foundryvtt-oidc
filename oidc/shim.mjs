import { loadConfig } from "./config.mjs";
import { getOidcClient } from "./client.mjs";
import { registerRoutes } from "./routes.mjs";
import { log } from "./log.mjs";

const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 120_000;

function locateExpressApp() {
  const candidates = [
    () => globalThis.config?.express,
    () => globalThis.config?.app,
    () => globalThis.express,
    () => globalThis.app,
  ];
  for (const c of candidates) {
    try {
      const v = c();
      if (v && typeof v.get === "function" && typeof v.use === "function") {
        return v;
      }
    } catch {
      // continue
    }
  }
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
            `timed out after ${POLL_TIMEOUT_MS}ms waiting for Foundry Express app on globalThis.config.express`,
          ),
        );
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
  });
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
    log.warn(
      "If your Foundry version exposes the Express app under a different name, set OIDC_DEBUG=1 and report what you see.",
    );
    return;
  }

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
