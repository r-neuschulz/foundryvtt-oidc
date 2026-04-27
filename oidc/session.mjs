import crypto from "node:crypto";
import { appendSetCookie, buildCookie } from "./cookies.mjs";
import { log } from "./log.mjs";

const SESSIONS_MODULE_URL = "file:///home/node/resources/app/dist/sessions.mjs";
const SESSION_MAX_AGE_MS = 864e5; // matches ClientSessions.COOKIE_MAX_AGE in Foundry

let sessionsSingleton = null;

export async function getSessionsSingleton() {
  if (sessionsSingleton) return sessionsSingleton;
  try {
    const m = await import(SESSIONS_MODULE_URL);
    if (!m?.default?.sessions) {
      throw new Error("imported sessions module has no `.default.sessions` Map");
    }
    sessionsSingleton = m.default;
    log.debug("acquired Foundry sessions singleton");
    return sessionsSingleton;
  } catch (e) {
    log.error(`Failed to import Foundry sessions module: ${e.message}`);
    return null;
  }
}

export async function mintSession(user, res, cfg, { admin = false } = {}) {
  const sessions = await getSessionsSingleton();
  if (!sessions) {
    throw new Error("Foundry sessions singleton unavailable. Cannot mint session.");
  }

  const userId = user.id ?? user._id;
  if (!userId) throw new Error("Cannot mint session: user has no id");

  const world = globalThis.game?.world;
  const worldId = world?.id;
  if (!worldId) {
    throw new Error("No active world; cannot bind session to a world.");
  }

  const id = crypto.randomBytes(12).toString("hex"); // 24 hex chars, matches randomString(24)
  const sessionData = {
    id,
    admin: !!admin,
    expires: Date.now() + SESSION_MAX_AGE_MS,
    worlds: { [worldId]: userId },
    messages: [],
  };

  sessions.sessions.set(id, sessionData);
  log.info(
    `session minted: id=${id} user=${userId} world=${worldId} admin=${!!admin}`,
  );

  // Best-effort: notify world activity layer that this user has logged in
  try {
    if (typeof world.onUserLogin === "function") {
      await world.onUserLogin(user);
      log.debug(`world.onUserLogin invoked for ${userId}`);
    }
  } catch (e) {
    log.warn(`world.onUserLogin failed (non-fatal): ${e.message}`);
  }

  // Match Foundry's own ClientSessions.assign() byte-for-byte: no HttpOnly
  // (Foundry's client JS expects to read this cookie); SameSite=Strict.
  appendSetCookie(
    res,
    buildCookie(cfg.foundrySessionCookie, id, {
      maxAge: SESSION_MAX_AGE_MS,
      path: "/",
      sameSite: "Strict",
      secure: cfg.cookieSecure,
    }),
  );

  return id;
}
