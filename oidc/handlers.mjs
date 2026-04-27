import { generators, getOidcClient } from "./client.mjs";
import { signState, verifyState } from "./state.mjs";
import {
  ensureUser,
  deriveRole,
  deriveAdmin,
  syncUserAttributes,
} from "./users.mjs";
import { mintSession } from "./session.mjs";
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
    const client = await getOidcClient(cfg);
    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    const returnTo = safeReturnTo(parseQuery(req).get("returnTo"));

    const cookie = signState(
      { state, nonce, codeVerifier, returnTo, ts: Date.now() },
      cfg.stateSecret,
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
      const client = await getOidcClient(cfg);
      const endSession = client.issuer.metadata.end_session_endpoint;
      if (endSession) {
        const u = new URL(endSession);
        u.searchParams.set("client_id", cfg.clientId);
        const post = postLogoutRedirect(req, cfg);
        if (post) u.searchParams.set("post_logout_redirect_uri", post);
        target = u.toString();
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
