import crypto from "node:crypto";
import { generators, getOidcClient } from "./client.mjs";
import { signState, verifyState } from "./state.mjs";
import { ensureUser, deriveRole, dumpGlobals } from "./users.mjs";
import { mintSession } from "./session.mjs";
import { log } from "./log.mjs";

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function setStateCookie(res, name, value, secure) {
  res.cookie(name, value, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60 * 1000,
  });
}

function clearStateCookie(res, name, secure) {
  res.clearCookie(name, { path: "/", httpOnly: true, secure, sameSite: "lax" });
}

function safeReturnTo(input) {
  if (!input || typeof input !== "string") return "/game";
  if (!input.startsWith("/") || input.startsWith("//")) return "/game";
  return input;
}

async function loginHandler(cfg, req, res) {
  try {
    const client = await getOidcClient(cfg);
    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    const returnTo = safeReturnTo(req.query?.returnTo);

    const cookie = signState(
      { state, nonce, codeVerifier, returnTo, ts: Date.now() },
      cfg.clientSecret,
    );
    setStateCookie(res, cfg.cookieName, cookie, cfg.cookieSecure);

    const url = client.authorizationUrl({
      scope: cfg.scopes,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    log.debug(`/oidc/login -> redirect ${url.slice(0, 120)}...`);
    res.redirect(302, url);
  } catch (err) {
    log.error("login handler failed:", err);
    res.status(500).type("text/plain").send(`OIDC login init failed: ${err.message}`);
  }
}

async function callbackHandler(cfg, req, res) {
  try {
    const cookieRaw = readCookie(req, cfg.cookieName);
    const stateData = verifyState(cookieRaw, cfg.clientSecret);
    if (!stateData) {
      throw new Error("missing or invalid state cookie");
    }
    clearStateCookie(res, cfg.cookieName, cfg.cookieSecure);

    const client = await getOidcClient(cfg);
    const params = client.callbackParams(req);
    const tokenSet = await client.callback(cfg.redirectUri, params, {
      state: stateData.state,
      nonce: stateData.nonce,
      code_verifier: stateData.codeVerifier,
    });

    const claims = tokenSet.claims();
    const username = claims[cfg.usernameClaim];
    if (!username || typeof username !== "string") {
      throw new Error(
        `OIDC ID token missing username claim '${cfg.usernameClaim}'. Got claims: ${Object.keys(claims).join(",")}`,
      );
    }

    log.info(`OIDC login success: ${cfg.usernameClaim}=${username} sub=${claims.sub}`);

    if (cfg.debug) dumpGlobals();

    const role = deriveRole(claims, cfg);
    const user = await ensureUser(username, role);
    if (!user) {
      const html = `<!doctype html><html><body style="font-family:sans-serif;max-width:540px;margin:60px auto">
<h1>Foundry user not found</h1>
<p>You authenticated as <code>${escapeHtml(username)}</code> via OIDC, but no matching Foundry user exists, and auto-creation could not run on this Foundry version.</p>
<p>Ask your administrator to create a Foundry user with the name <code>${escapeHtml(username)}</code>, then sign in again.</p>
<p><a href="/oidc/login">Try again</a></p>
</body></html>`;
      res.status(403).type("text/html").send(html);
      return;
    }

    mintSession(user, res, cfg);

    const returnTo = safeReturnTo(stateData.returnTo);
    res.redirect(302, returnTo);
  } catch (err) {
    log.error("callback handler failed:", err);
    res
      .status(400)
      .type("text/plain")
      .send(`OIDC callback failed: ${err.message}\n\nReturn to /oidc/login to retry.`);
  }
}

function logoutHandler(cfg, req, res) {
  res.clearCookie(cfg.foundrySessionCookie, { path: "/" });
  res.clearCookie(cfg.cookieName, { path: "/" });
  res.redirect(302, "/");
}

function joinInterceptor(cfg, req, res, next) {
  if (req.method !== "GET") return next();
  if (!cfg.autoRedirect) return next();
  if (req.query && req.query[cfg.bypassQuery] !== undefined) return next();
  if (req.query && req.query.from === "oidc") return next();
  const sessionCookie = readCookie(req, cfg.foundrySessionCookie);
  if (sessionCookie) return next();
  log.debug(`auto-redirect /join -> /oidc/login`);
  return res.redirect(302, "/oidc/login?returnTo=/game");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function registerRoutes(app, cfg) {
  app.get("/oidc/login", (req, res) => loginHandler(cfg, req, res));
  app.get("/oidc/callback", (req, res) => callbackHandler(cfg, req, res));
  app.get("/oidc/logout", (req, res) => logoutHandler(cfg, req, res));
  app.get("/oidc/health", (req, res) =>
    res.type("application/json").send({ ok: true, issuer: cfg.issuer }),
  );

  app.get("/join", (req, res, next) => joinInterceptor(cfg, req, res, next));
  promoteRouteToFront(app, "/join");
  promoteRouteToFront(app, "/oidc/login");
  promoteRouteToFront(app, "/oidc/callback");
  promoteRouteToFront(app, "/oidc/logout");
  promoteRouteToFront(app, "/oidc/health");

  log.info(
    `routes registered: /oidc/login, /oidc/callback, /oidc/logout, /oidc/health` +
      (cfg.autoRedirect ? `, /join (auto-redirect)` : ""),
  );
}

function promoteRouteToFront(app, path) {
  const stack = app?._router?.stack || app?.router?.stack;
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
