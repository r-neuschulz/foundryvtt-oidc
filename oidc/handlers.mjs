import { Readable } from "node:stream";
import { oidc, getOidcConfig } from "./client.mjs";
import { signState, verifyState } from "./state.mjs";
import {
  ensureUser,
  deriveRole,
  deriveAdmin,
  syncUserAttributes,
} from "./users.mjs";
import { mintSession } from "./session.mjs";
import { getAvatarUrl } from "./avatar-map.mjs";
import {
  readCookie,
  setStateCookie,
  clearStateCookie,
  clearSessionCookie,
} from "./cookies.mjs";
import {
  redirect,
  sendText,
  sendHtml,
  sendJson,
  escapeHtml,
  parseQuery,
  safeReturnTo,
} from "./http-utils.mjs";
import { log } from "./log.mjs";

export async function loginHandler(cfg, req, res) {
  try {
    const config = await getOidcConfig(cfg);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const returnTo = safeReturnTo(parseQuery(req).get("returnTo"));

    const cookie = signState(
      { state, nonce, codeVerifier, returnTo, ts: Date.now() },
      cfg.stateSecret,
    );
    setStateCookie(res, cfg.cookieName, cookie, cfg.cookieSecure);

    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: cfg.redirectUri,
      scope: cfg.scopes,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const href = url.toString();
    log.debug(`/oidc/login -> redirect ${href.slice(0, 120)}...`);
    redirect(res, href);
  } catch (err) {
    log.error("login handler failed:", err);
    try {
      sendText(res, 500, `OIDC login init failed: ${err.message}`);
    } catch (e2) {
      log.error("error response failed:", e2);
    }
  }
}

const NO_WORLD_HTML = (username) => `<!doctype html><html><body style="font-family:sans-serif;max-width:540px;margin:60px auto">
<h1>No active Foundry world</h1>
<p>You authenticated successfully as <code>${escapeHtml(username)}</code>, but Foundry has no world loaded yet, so user records cannot be created.</p>
<p>The Foundry administrator should sign in via the admin key, launch a world, and leave it running. After that, OIDC sign-ins will Just Work.</p>
<p><a href="/setup">Go to Foundry setup</a> · <a href="/oidc/login">Try again</a></p>
</body></html>`;

const USER_NOT_FOUND_HTML = (username) => `<!doctype html><html><body style="font-family:sans-serif;max-width:540px;margin:60px auto">
<h1>Foundry user not found</h1>
<p>You authenticated as <code>${escapeHtml(username)}</code> via OIDC, but no matching Foundry user exists and auto-creation failed (see container logs for details).</p>
<p>Ask your administrator to create a Foundry user with the name <code>${escapeHtml(username)}</code>, then sign in again.</p>
<p><a href="/oidc/login">Try again</a></p>
</body></html>`;

export async function callbackHandler(cfg, req, res) {
  try {
    const cookieRaw = readCookie(req, cfg.cookieName);
    const stateData = verifyState(cookieRaw, cfg.stateSecret);
    if (!stateData) throw new Error("missing or invalid state cookie");
    clearStateCookie(res, cfg.cookieName);

    const config = await getOidcConfig(cfg);
    // openid-client v6 reads the auth response off a URL or Request.
    // Foundry's req has the path+query in req.url; reconstruct the absolute
    // URL using cfg.redirectUri's origin so the lib can extract `code`/`state`.
    const currentUrl = new URL(req.url, new URL(cfg.redirectUri).origin);
    const tokenSet = await oidc.authorizationCodeGrant(config, currentUrl, {
      expectedState: stateData.state,
      expectedNonce: stateData.nonce,
      pkceCodeVerifier: stateData.codeVerifier,
      idTokenExpected: true,
    });

    const claims = tokenSet.claims();
    if (!claims) throw new Error("authorization response had no ID token");
    const username = claims[cfg.usernameClaim];
    if (!username || typeof username !== "string") {
      throw new Error(
        `OIDC ID token missing username claim '${cfg.usernameClaim}'. Got claims: ${Object.keys(claims).join(",")}`,
      );
    }

    log.info(
      `OIDC login success: ${cfg.usernameClaim}=${username} sub=${claims.sub}`,
    );

    if (cfg.debug) {
      const { dumpGlobals } = await import("./diagnostics.mjs");
      dumpGlobals();
    }

    const role = deriveRole(claims, cfg);
    const result = await ensureUser(username, role);
    if (result.kind === "no_world") {
      sendHtml(res, 503, NO_WORLD_HTML(username));
      return;
    }
    if (result.kind === "create_failed" || result.kind === "no_api") {
      sendHtml(res, 403, USER_NOT_FOUND_HTML(username));
      return;
    }
    const user = result.user;

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

// Single-Logout: clear the local session entry, drop both cookies,
// then redirect to the IdP's end_session_endpoint so the Keycloak
// session also ends. Without this step, /oidc/login on the same
// browser would silently re-authenticate.
export async function logoutHandler(cfg, req, res) {
  try {
    // Drop our minted session from Foundry's in-memory map
    try {
      const { getSessionsSingleton } = await import("./session.mjs");
      const sessions = await getSessionsSingleton();
      const sid = readCookie(req, cfg.foundrySessionCookie);
      if (sessions && sid) sessions.sessions.delete(sid);
    } catch (e) {
      log.debug(`session map cleanup skipped: ${e.message}`);
    }

    clearSessionCookie(res, cfg.foundrySessionCookie);
    clearStateCookie(res, cfg.cookieName);

    let target = "/";
    try {
      const config = await getOidcConfig(cfg);
      if (config.serverMetadata().end_session_endpoint) {
        const params = {};
        const post = postLogoutRedirect(req, cfg);
        if (post) params.post_logout_redirect_uri = post;
        target = oidc.buildEndSessionUrl(config, params).toString();
      }
    } catch (e) {
      log.debug(`could not build IdP logout URL: ${e.message}`);
    }
    redirect(res, target);
  } catch (err) {
    log.error("logout handler failed:", err);
    try {
      sendText(res, 500, `OIDC logout failed: ${err.message}`);
    } catch {}
  }
}

function postLogoutRedirect(req, cfg) {
  // Best-effort: build an absolute URL back to "/" using the proxy
  // hostname Foundry was told about.
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!host) return null;
  const proto =
    req.headers["x-forwarded-proto"] ||
    (cfg.cookieSecure ? "https" : "http");
  return `${proto}://${host}/`;
}

// Streaming proxy for avatars whose upstream URL has no recognizable
// image extension (e.g. Keycloak/Gravatar `/avatar/<hash>` endpoints).
// Foundry's User.avatar validator inspects the URL string, so we stash
// the real upstream in avatar-map.mjs and point user.avatar at this
// route, which always ends in `.png` to satisfy the validator.
const AVATAR_PROXY_TIMEOUT_MS = 10_000;

export async function avatarProxyHandler(cfg, req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const last = url.pathname.split("/").pop() || "";
    const userId = last.replace(/\.[^.]+$/, "");
    if (!userId) return sendText(res, 404, "not found");

    const upstream = await getAvatarUrl(userId);
    if (!upstream) return sendText(res, 404, "no picture for this user");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AVATAR_PROXY_TIMEOUT_MS);
    let upstreamRes;
    try {
      upstreamRes = await fetch(upstream, {
        redirect: "follow",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!upstreamRes.ok) {
      return sendText(res, 502, `upstream ${upstreamRes.status}`);
    }
    const ct =
      upstreamRes.headers.get("content-type") || "application/octet-stream";
    if (!ct.startsWith("image/")) {
      return sendText(res, 502, `upstream returned non-image (${ct})`);
    }

    res.writeHead(200, {
      "content-type": ct,
      "cache-control": "private, max-age=300",
    });
    if (upstreamRes.body) {
      Readable.fromWeb(upstreamRes.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    log.error("avatar proxy failed:", err);
    try {
      sendText(res, 500, `avatar proxy failed: ${err.message}`);
    } catch {}
  }
}

export function joinInterceptor(cfg, req, res, next) {
  if (req.method !== "GET") return next();
  if (!cfg.autoRedirect) return next();
  const q = parseQuery(req);
  if (q.has(cfg.bypassQuery)) return next();
  if (q.get("from") === "oidc") return next();
  const sessionCookie = readCookie(req, cfg.foundrySessionCookie);
  if (sessionCookie) return next();
  log.debug(`/join -> 302 /oidc/login`);
  return redirect(res, "/oidc/login?returnTo=/game");
}
