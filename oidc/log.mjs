const PREFIX = "[oidc-shim]";

export const log = {
  info: (...args) => console.log(PREFIX, ...args),
  warn: (...args) => console.warn(PREFIX, ...args),
  error: (...args) => console.error(PREFIX, ...args),
  debug: (...args) => {
    if (process.env.OIDC_DEBUG === "1" || process.env.OIDC_DEBUG === "true") {
      console.log(PREFIX, "[debug]", ...args);
    }
  },
};
