import fs from "node:fs/promises";
import { log } from "./log.mjs";

// Persistent userId -> upstream picture URL mapping. Used so the proxy
// route at /oidc/avatar/<userId>.png can resolve the upstream image
// without depending on Foundry's user.flags (which has scope rules).
const MAP_PATH = "/data/oidc-avatars.json";
let cache = null;

async function load() {
  if (cache) return cache;
  try {
    const content = await fs.readFile(MAP_PATH, "utf-8");
    const parsed = JSON.parse(content);
    cache =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
  } catch (e) {
    if (e.code !== "ENOENT") {
      log.warn(`avatar map read failed (${e.code ?? e.message}); starting empty`);
    }
    cache = {};
  }
  return cache;
}

export async function getAvatarUrl(userId) {
  if (!userId) return null;
  const map = await load();
  return map[userId] ?? null;
}

export async function setAvatarUrl(userId, url) {
  if (!userId) return false;
  const map = await load();
  if (map[userId] === url) return false;
  map[userId] = url;
  try {
    await fs.writeFile(MAP_PATH, JSON.stringify(map, null, 2));
    cache = map;
    return true;
  } catch (e) {
    log.error(`avatar map write failed: ${e.message}`);
    return false;
  }
}
