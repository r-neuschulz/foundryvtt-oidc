import crypto from "node:crypto";
import { log } from "./log.mjs";

function getSessionStore() {
  const candidates = [
    () => globalThis.config?.auth?.sessions,
    () => globalThis.auth?.sessions,
    () => globalThis.config?.sessions,
  ];
  for (const c of candidates) {
    try {
      const v = c();
      if (v) return v;
    } catch {
      // try next
    }
  }
  return null;
}

function getCurrentWorldId() {
  const candidates = [
    () => globalThis.config?.options?.world,
    () => globalThis.config?.world?.id,
    () => globalThis.game?.world?.id,
    () => globalThis.world?.id,
  ];
  for (const c of candidates) {
    try {
      const v = c();
      if (v) return v;
    } catch {
      // try next
    }
  }
  return null;
}

export function mintSession(user, res, cfg) {
  const store = getSessionStore();
  if (!store) {
    throw new Error(
      "Foundry session store not found at globalThis.config.auth.sessions. " +
        "Cannot mint session.",
    );
  }

  const userId = user.id ?? user._id;
  if (!userId) {
    throw new Error("Cannot mint session: user has no id");
  }

  const worldId = getCurrentWorldId();
  if (!worldId) {
    log.warn("no current world detected; session may not bind correctly");
  }

  const sessionId = crypto.randomBytes(16).toString("hex");

  const payload = {
    id: sessionId,
    userId,
    user: userId,
    world: worldId,
    worldId,
    created: Date.now(),
    lastSeen: Date.now(),
  };

  if (typeof store.create === "function") {
    try {
      store.create(sessionId, payload);
      log.debug(`session minted via store.create: ${sessionId}`);
    } catch (e) {
      log.warn(`store.create failed (${e.message}); falling back to direct write`);
      writeDirect(store, sessionId, payload);
    }
  } else if (typeof store.set === "function") {
    try {
      store.set(sessionId, payload);
      log.debug(`session minted via store.set: ${sessionId}`);
    } catch (e) {
      log.warn(`store.set failed (${e.message}); falling back to direct write`);
      writeDirect(store, sessionId, payload);
    }
  } else {
    writeDirect(store, sessionId, payload);
  }

  res.cookie(cfg.foundrySessionCookie, sessionId, {
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: "lax",
    path: "/",
  });

  log.info(`session issued for user=${userId} world=${worldId}`);
  return sessionId;
}

function writeDirect(store, id, payload) {
  if (store.sessions && typeof store.sessions === "object") {
    store.sessions[id] = payload;
    return;
  }
  if (store instanceof Map) {
    store.set(id, payload);
    return;
  }
  // last resort: assume the store is itself the dict
  store[id] = payload;
}
