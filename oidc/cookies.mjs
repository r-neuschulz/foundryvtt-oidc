// Cookie helpers shared by the state machinery (oidc_state) and the
// minted Foundry session cookie. We avoid Express's res.cookie because
// Foundry's response object is missing the Express response prototype
// in our handler context (see commit dd4ddf0).

export function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function appendSetCookie(res, header) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) res.setHeader("Set-Cookie", header);
  else if (Array.isArray(existing))
    res.setHeader("Set-Cookie", [...existing, header]);
  else res.setHeader("Set-Cookie", [existing, header]);
}

export function buildCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined)
    parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.httpOnly) parts.push(`HttpOnly`);
  if (opts.secure) parts.push(`Secure`);
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join("; ");
}

const STATE_PATH = "/oidc/";

export function setStateCookie(res, name, value, secure) {
  appendSetCookie(
    res,
    buildCookie(name, value, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: STATE_PATH,
      maxAge: 10 * 60 * 1000,
    }),
  );
}

export function clearStateCookie(res, name) {
  appendSetCookie(
    res,
    `${name}=; Max-Age=0; Path=${STATE_PATH}; HttpOnly; SameSite=Lax`,
  );
}

export function clearSessionCookie(res, name) {
  appendSetCookie(res, `${name}=; Max-Age=0; Path=/; SameSite=Lax`);
}
