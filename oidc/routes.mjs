import {
  loginHandler,
  callbackHandler,
  logoutHandler,
  joinInterceptor,
  avatarProxyHandler,
} from "./handlers.mjs";
import { sendJson } from "./http-utils.mjs";
import { log } from "./log.mjs";

export function registerRoutes(app, cfg) {
  app.get("/oidc/login", (req, res) => loginHandler(cfg, req, res));
  app.get("/oidc/callback", (req, res) => callbackHandler(cfg, req, res));
  app.get("/oidc/logout", (req, res) => logoutHandler(cfg, req, res));
  app.get("/oidc/health", (req, res) =>
    sendJson(res, 200, { ok: true, issuer: cfg.issuer }),
  );
  app.get("/oidc/avatar/:file", (req, res) =>
    avatarProxyHandler(cfg, req, res),
  );

  app.get("/join", (req, res, next) => joinInterceptor(cfg, req, res, next));

  // Foundry's view routes (/join, /game, ...) live in a child express.Router()
  // mounted on the outer app. Our app.get(path, handler) lands at the *end*
  // of the outer app._router.stack, behind the sub-router mount point — so
  // requests would reach Foundry first. Promote our routes to position 0
  // so they preempt the sub-router during dispatch.
  for (const p of [
    "/join",
    "/oidc/login",
    "/oidc/callback",
    "/oidc/logout",
    "/oidc/health",
    "/oidc/avatar/:file",
  ]) {
    promoteRouteToFront(app, p);
  }

  log.info(
    `routes registered: /oidc/login, /oidc/callback, /oidc/logout, /oidc/health` +
      (cfg.autoRedirect ? `, /join (auto-redirect)` : ""),
  );
}

function promoteRouteToFront(app, path) {
  const stack = app?._router?.stack;
  if (!Array.isArray(stack)) return;
  let idx = -1;
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]?.route?.path === path) {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    log.warn(`could not promote route ${path}: layer not found`);
    return;
  }
  const [layer] = stack.splice(idx, 1);
  stack.unshift(layer);
}
