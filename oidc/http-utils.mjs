// Response helpers that work without Express's response prototype.
// Foundry's handler context delivers a stripped res object whose
// .cookie / .status / .send / .redirect methods are missing, so we
// drive everything through writeHead / setHeader / end.

function safeHeaderValue(v) {
  // Defense against header-injection via embedded CR/LF, which Node
  // would normally reject anyway, but stripping is cheap insurance.
  return String(v).replace(/[\r\n]+/g, "");
}

export function redirect(res, url) {
  res.writeHead(302, { Location: safeHeaderValue(url) });
  res.end();
}

export function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

export function sendHtml(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

export function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Parse query string off req.url. We're typically promoted ahead of
// Express's `query` middleware, so req.query is undefined when our
// handlers fire. URL needs an absolute base; "http://x" is fine since
// we only use the searchParams.
export function parseQuery(req) {
  return new URL(req.url || "/", "http://x").searchParams;
}

// Only allow site-relative paths starting with a single "/" — rejects
// "//evil.example.com" (which is a protocol-relative absolute URL).
export function safeReturnTo(input, fallback = "/game") {
  if (typeof input !== "string" || !input) return fallback;
  if (!input.startsWith("/") || input.startsWith("//")) return fallback;
  return input;
}
