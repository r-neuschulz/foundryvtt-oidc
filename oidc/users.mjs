import { log } from "./log.mjs";

const ROLE = {
  NONE: 0,
  PLAYER: 1,
  TRUSTED: 2,
  ASSISTANT: 3,
  GAMEMASTER: 4,
};

function claimsHasGroup(claims, cfg, names) {
  if (!names || names.length === 0) return false;
  const groups = claims[cfg.groupsClaim];
  if (!Array.isArray(groups)) return false;
  for (const g of names) {
    if (groups.includes(g) || groups.includes(`/${g}`)) return true;
  }
  return false;
}

export function deriveRole(claims, cfg) {
  if (claimsHasGroup(claims, cfg, cfg.gmGroups)) return ROLE.GAMEMASTER;
  return ROLE.PLAYER;
}

export function deriveAdmin(claims, cfg) {
  return claimsHasGroup(claims, cfg, cfg.adminGroups);
}

function getUserClass() {
  return globalThis.config?.db?.User || null;
}

export async function findUserByName(name) {
  const cls = getUserClass();
  if (!cls) return null;
  const lower = name.toLowerCase();

  if (typeof cls.findOne === "function") {
    try {
      const u = await cls.findOne({ name });
      if (u) return u;
    } catch (e) {
      log.debug(`User.findOne({name}) failed: ${e.message}`);
    }
  }

  if (typeof cls.find === "function") {
    try {
      const all = await cls.find({});
      if (Array.isArray(all)) {
        const u = all.find((x) => (x?.name || "").toLowerCase() === lower);
        if (u) return u;
      }
    } catch (e) {
      log.debug(`User.find({}) failed: ${e.message}`);
    }
  }

  return null;
}

function isWorldActive() {
  const cls = getUserClass();
  if (!cls) return false;
  if (typeof cls.connected !== "undefined" && cls.connected === false) return false;
  if (typeof cls.ready !== "undefined" && cls.ready === false) return false;
  if (typeof globalThis.game?.active !== "undefined" && globalThis.game.active === false) return false;
  return true;
}

async function elevateUserRole(existing, targetRole) {
  const currentRole = existing?.role ?? 0;
  if (typeof targetRole !== "number" || targetRole <= currentRole) return false;

  // Preferred: full Document.update() lifecycle (broadcasts, hooks, persistence)
  if (typeof existing.update === "function") {
    try {
      await existing.update({ role: targetRole });
      log.info(
        `elevated user ${existing.name}: role ${currentRole} -> ${targetRole} (via update)`,
      );
      return true;
    } catch (e) {
      log.warn(`existing.update({role}) failed: ${e.message}`);
    }
  }

  // Fallback: mutate source and persist directly (no socket broadcast, but role flips)
  if (
    typeof existing.updateSource === "function" &&
    typeof existing.save === "function"
  ) {
    try {
      existing.updateSource({ role: targetRole });
      await existing.save();
      log.info(
        `elevated user ${existing.name}: role ${currentRole} -> ${targetRole} (via updateSource+save)`,
      );
      return true;
    } catch (e) {
      log.warn(`updateSource+save failed: ${e.message}`);
    }
  }

  log.warn(
    `could not elevate role for '${existing.name}' (current=${currentRole}, target=${targetRole}); admin must promote manually in /players`,
  );
  return false;
}

export async function ensureUser(name, role) {
  if (!isWorldActive()) {
    log.error(
      `No active Foundry world. The User database is unavailable until a world is loaded. ` +
        `Sign in to Foundry as admin once and launch a world; subsequent OIDC logins will work.`,
    );
    return { _noWorld: true };
  }

  const existing = await findUserByName(name);
  if (existing) {
    log.info(`existing user matched: name=${name} id=${existing.id ?? existing._id}`);
    await elevateUserRole(existing, role);
    return existing;
  }

  const cls = getUserClass();
  if (!cls?.create) {
    log.error(
      `Cannot auto-create user '${name}': config.db.User.create not available. ` +
        `Set OIDC_DEBUG=1 to introspect global state.`,
    );
    return null;
  }

  try {
    const u = await cls.create({ name, role });
    log.info(`auto-created Foundry user: name=${name} role=${role} id=${u?.id ?? u?._id}`);
    return u;
  } catch (e) {
    log.error(`User.create failed for '${name}':`, e);
    return null;
  }
}

function shape(o, depth = 1) {
  if (o == null) return null;
  if (typeof o !== "object" && typeof o !== "function") return typeof o;
  const keys = Object.keys(o).slice(0, 50);
  const proto = Object.getPrototypeOf(o);
  const protoKeys = proto && proto !== Object.prototype && proto !== Function.prototype
    ? Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor").slice(0, 40)
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

export { ROLE };
