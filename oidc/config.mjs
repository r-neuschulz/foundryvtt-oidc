import { log } from "./log.mjs";

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `[oidc-shim] missing required env var ${name}. ` +
        `OIDC bootstrap aborted; Foundry will continue without SSO.`,
    );
  }
  return v.trim();
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function csv(name) {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig() {
  const issuer = required("OIDC_ISSUER");
  const clientId = required("OIDC_CLIENT_ID");
  const clientSecret = required("OIDC_CLIENT_SECRET");
  const redirectUri = required("OIDC_REDIRECT_URI");

  const cfg = {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    scopes: optional("OIDC_SCOPES", "openid profile email"),
    usernameClaim: optional("OIDC_USERNAME_CLAIM", "preferred_username"),
    autoRedirect: bool("OIDC_AUTO_REDIRECT", true),
    bypassQuery: optional("OIDC_BYPASS_QUERY", "local"),
    gmGroups: csv("OIDC_GM_GROUPS"),
    adminGroups: csv("OIDC_ADMIN_GROUPS"),
    groupsClaim: optional("OIDC_GROUPS_CLAIM", "groups"),
    cookieName: optional("OIDC_COOKIE_NAME", "oidc_state"),
    cookieSecure: bool("OIDC_COOKIE_SECURE", true),
    foundrySessionCookie: optional("FOUNDRY_SESSION_COOKIE", "session"),
    debug: bool("OIDC_DEBUG", false),
  };

  log.info(`config loaded: issuer=${cfg.issuer} client_id=${cfg.clientId}`);
  log.debug("full config (secrets redacted):", {
    ...cfg,
    clientSecret: "***",
  });
  return cfg;
}
