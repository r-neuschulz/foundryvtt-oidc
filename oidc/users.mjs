import { log } from "./log.mjs";

const ROLE = {
  NONE: 0,
  PLAYER: 1,
  TRUSTED: 2,
  ASSISTANT: 3,
  GAMEMASTER: 4,
};

export function deriveRole(claims, cfg) {
  const groups = claims[cfg.groupsClaim];
  if (Array.isArray(groups) && cfg.gmGroups.length > 0) {
    for (const g of cfg.gmGroups) {
      if (groups.includes(g) || groups.includes(`/${g}`)) {
        return ROLE.GAMEMASTER;
      }
    }
  }
  return ROLE.PLAYER;
}

function getCollections() {
  const candidates = [
    () => globalThis.game?.users,
    () => globalThis.config?.game?.users,
    () => globalThis.config?.collections?.users,
    () => globalThis.config?.db?.users,
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

export function findUserByName(name) {
  const users = getCollections();
  if (!users) return null;
  try {
    if (typeof users.getName === "function") {
      const u = users.getName(name);
      if (u) return u;
    }
    if (typeof users.find === "function") {
      const u = users.find(
        (x) => (x?.name || "").toLowerCase() === name.toLowerCase(),
      );
      if (u) return u;
    }
    if (typeof users.contents !== "undefined") {
      const u = users.contents.find?.(
        (x) => (x?.name || "").toLowerCase() === name.toLowerCase(),
      );
      if (u) return u;
    }
    if (typeof users[Symbol.iterator] === "function") {
      for (const u of users) {
        if ((u?.name || "").toLowerCase() === name.toLowerCase()) return u;
      }
    }
  } catch (e) {
    log.warn(`findUserByName failed: ${e.message}`);
  }
  return null;
}

export async function ensureUser(name, role) {
  const existing = findUserByName(name);
  if (existing) {
    log.debug(`existing user matched: name=${name} id=${existing.id ?? existing._id}`);
    return existing;
  }

  const userClass = globalThis.User || globalThis.config?.User;
  if (userClass && typeof userClass.create === "function") {
    try {
      const u = await userClass.create({ name, role });
      log.info(`auto-created Foundry user: name=${name} role=${role}`);
      return u;
    } catch (e) {
      log.warn(`User.create failed: ${e.message}`);
    }
  }

  const users = getCollections();
  if (users && typeof users.create === "function") {
    try {
      const u = await users.create({ name, role });
      log.info(`auto-created Foundry user via collection: name=${name} role=${role}`);
      return u;
    } catch (e) {
      log.warn(`users.create failed: ${e.message}`);
    }
  }

  log.error(
    `Cannot auto-create user '${name}': no Foundry User API found in this version. ` +
      `Admin must create the user in Foundry's /players UI. ` +
      `Set OIDC_DEBUG=1 to introspect global state.`,
  );
  return null;
}

export function dumpGlobals() {
  const out = {
    hasGame: !!globalThis.game,
    hasConfig: !!globalThis.config,
    hasUser: !!globalThis.User,
    configKeys: globalThis.config ? Object.keys(globalThis.config).slice(0, 30) : null,
    gameKeys: globalThis.game ? Object.keys(globalThis.game).slice(0, 30) : null,
  };
  log.debug("globals:", out);
  return out;
}

export { ROLE };
