const PREFIX = "[oidc-shim]";

// All shim output goes to stderr so we never pollute stdout —
// felddy's entrypoint captures stdout from helper Node scripts
// (e.g. presigned-URL fetcher) and pipes it to curl. A single line
// of our output on stdout breaks the pipeline.
function format(a) {
  if (typeof a === "string") return a;
  if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ""}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function emit(tag, args) {
  const parts = [PREFIX];
  if (tag) parts.push(tag);
  for (const a of args) parts.push(format(a));
  process.stderr.write(parts.join(" ") + "\n");
}

export const log = {
  info: (...args) => emit(null, args),
  warn: (...args) => emit("[warn]", args),
  error: (...args) => emit("[error]", args),
  debug: (...args) => {
    if (process.env.OIDC_DEBUG === "1" || process.env.OIDC_DEBUG === "true") {
      emit("[debug]", args);
    }
  },
};
