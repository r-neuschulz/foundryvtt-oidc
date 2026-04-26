import crypto from "node:crypto";

function deriveKey(secret) {
  return crypto.createHash("sha256").update(`oidc-state:${secret}`).digest();
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(
    str.replace(/-/g, "+").replace(/_/g, "/") + pad,
    "base64",
  );
}

export function signState(payload, secret) {
  const key = deriveKey(secret);
  const body = base64url(JSON.stringify(payload));
  const mac = base64url(
    crypto.createHmac("sha256", key).update(body).digest(),
  );
  return `${body}.${mac}`;
}

export function verifyState(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const key = deriveKey(secret);
  const expected = base64url(
    crypto.createHmac("sha256", key).update(body).digest(),
  );
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(fromBase64url(body).toString("utf8"));
  } catch {
    return null;
  }
}
