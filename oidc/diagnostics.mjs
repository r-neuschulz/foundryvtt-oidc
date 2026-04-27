// Lazily-loaded debug helpers. The shim only imports this module when
// OIDC_DEBUG=1, so the introspection code (and its small but non-zero
// memory footprint) doesn't sit in production processes.

import { log } from "./log.mjs";

function shape(o) {
  if (o == null) return null;
  if (typeof o !== "object" && typeof o !== "function") return typeof o;
  const keys = Object.keys(o).slice(0, 50);
  const proto = Object.getPrototypeOf(o);
  const protoKeys =
    proto && proto !== Object.prototype && proto !== Function.prototype
      ? Object.getOwnPropertyNames(proto)
          .filter((n) => n !== "constructor")
          .slice(0, 40)
      : [];
  return {
    ctor: o?.constructor?.name,
    keys,
    protoKeys,
    size: o?.size ?? o?.length,
  };
}

export function dumpGlobals() {
  try {
    const g = globalThis;
    const out = {
      hasGame: !!g.game,
      hasConfig: !!g.config,
      hasUser: !!g.User,
      hasFoundry: !!g.foundry,
      configKeys: g.config ? Object.keys(g.config).slice(0, 40) : null,
      gameKeys: g.game ? Object.keys(g.game).slice(0, 40) : null,
      foundryKeys: g.foundry ? Object.keys(g.foundry).slice(0, 40) : null,
      gameUsers: shape(g.game?.users),
      configDb: shape(g.config?.db),
      configDbUser: shape(g.config?.db?.User),
      configDbUsers: shape(g.config?.db?.users),
      foundryDocuments: g.foundry?.documents
        ? Object.keys(g.foundry.documents).slice(0, 30)
        : null,
      foundryDocumentsUser: shape(g.foundry?.documents?.User),
    };
    log.info("dumpGlobals:", out);
    return out;
  } catch (e) {
    log.error("dumpGlobals failed:", e);
    return null;
  }
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

export function dumpActiveHandles() {
  try {
    const handles = process._getActiveHandles?.() ?? [];
    const summary = handles.slice(0, 20).map((h, i) => {
      try {
        return {
          i,
          ctor: h?.constructor?.name,
          reqListeners: h?.listeners?.("request")?.length,
        };
      } catch {
        return { i, err: "introspection failed" };
      }
    });
    log.info("active handles:", JSON.stringify(summary));
    log.info(
      "globalThis keys (truncated):",
      Object.keys(globalThis).slice(0, 50).join(","),
    );
    if (globalThis.config) {
      log.info(
        "globalThis.config keys:",
        Object.keys(globalThis.config).slice(0, 30).join(","),
      );
    }
  } catch (e) {
    log.error(`active-handles dump failed: ${e.message}`);
  }
}
