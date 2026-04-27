import crypto from "node:crypto";
import { generators, getOidcClient } from "./client.mjs";
import { signState, verifyState } from "./state.mjs";
import {
  ensureUser,
  deriveRole,
  deriveAdmin,
  syncUserAttributes,
  dumpGlobals,
} from "./users.mjs";
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

function appendSetCookie(res, header) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", header);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, header]);
  } else {
    res.setHeader("Set-Cookie", [existing, header]);
  }
}

function buildCookie(name, value, opts) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.httpOnly) parts.push(`HttpOnly`);
  if (opts.secure) parts.push(`Secure`);
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join("; ");
}

function setStateCookie(res, name, value, secure) {
  appendSetCookie(
    res,
    buildCookie(name, value, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: 10 * 60 * 1000,
    }),
  );
}

function clearCookie(res, name) {
  appendSetCookie(res, `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

function redirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function sendHtml(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
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
    redirect(res, url);
  } catch (err) {
    log.error("login handler failed:", err);
    try {
      sendText(res, 500, `OIDC login init failed: ${err.message}`);
    } catch (e2) {
      log.error("error response failed:", e2);
    }
  }
}

async function callbackHandler(cfg, req, res) {
  try {
    const cookieRaw = readCookie(req, cfg.cookieName);
    const stateData = verifyState(cookieRaw, cfg.clientSecret);
    if (!stateData) {
      throw new Error("missing or invalid state cookie");
    }
    clearCookie(res, cfg.cookieName);

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
    if (user && user._noWorld) {
      const html = `<!doctype html><html><body style="font-family:sans-serif;max-width:540px;margin:60px auto">
<h1>No active Foundry world</h1>
<p>You authenticated successfully as <code>${escapeHtml(username)}</code>, but Foundry has no world loaded yet, so user records cannot be created.</p>
<p>The Foundry administrator should sign in via the admin key, launch a world, and leave it running. After that, OIDC sign-ins will Just Work.</p>
<p><a href="/setup">Go to Foundry setup</a> · <a href="/oidc/login">Try again</a></p>
</body></html>`;
      sendHtml(res, 503, html);
      return;
    }
    if (!user) {
      const html = `<!doctype html><html><body style="font-family:sans-serif;max-width:540px;margin:60px auto">
<h1>Foundry user not found</h1>
<p>You authenticated as <code>${escapeHtml(username)}</code> via OIDC, but no matching Foundry user exists and auto-creation failed (see container logs for details).</p>
<p>Ask your administrator to create a Foundry user with the name <code>${escapeHtml(username)}</code>, then sign in again.</p>
<p><a href="/oidc/login">Try again</a></p>
</body></html>`;
      sendHtml(res, 403, html);
      return;
    }

    const admin = deriveAdmin(claims, cfg);
    await syncUserAttributes(user, claims, cfg);
    await mintSession(user, res, cfg, { admin });

    const returnTo = safeReturnTo(stateData.returnTo);
    redirect(res, returnTo);
  } catch (err) {
    log.error("callback handler failed:", err);
    try {
      sendText(
        res,
        400,
        `OIDC callback failed: ${err.message}\n\nReturn to /oidc/login to retry.`,
      );
    } catch (e2) {
      log.error("error response failed:", e2);
    }
  }
}

function logoutHandler(cfg, req, res) {
  clearCookie(res, cfg.foundrySessionCookie);
  clearCookie(res, cfg.cookieName);
  redirect(res, "/");
}

function joinInterceptor(cfg, req, res, next) {
  if (req.method !== "GET") return next();
  if (!cfg.autoRedirect) return next();
  // We sit before Express's `query` middleware, so req.query is undefined here.
  // Parse the query off req.url ourselves.
  const url = new URL(req.url, "http://x");
  if (url.searchParams.has(cfg.bypassQuery)) return next();
  if (url.searchParams.get("from") === "oidc") return next();
  const sessionCookie = readCookie(req, cfg.foundrySessionCookie);
  if (sessionCookie) return next();
  log.debug(`/join -> 302 /oidc/login`);
  return redirect(res, "/oidc/login?returnTo=/game");
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
    sendJson(res, 200, { ok: true, issuer: cfg.issuer }),
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

export function dumpStack(app, label = "stack") {
  const stack = app?._router?.stack;
  if (!Array.isArray(stack)) {
    log.warn(`${label}: no _router.stack`);
    return;
  }
  log.info(`${label}: ${stack.length} layers`);
  for (let i = 0; i < Math.min(stack.length, 25); i++) {
    const l = stack[i];
    log.info(
      `  [${i}] name=${l?.name} route=${l?.route?.path ?? "(none)"} regexp=${String(l?.regexp).slice(0, 60)}`,
    );
  }
}
