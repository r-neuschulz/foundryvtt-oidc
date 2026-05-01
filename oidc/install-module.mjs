import fs from "node:fs/promises";
import path from "node:path";
import { log } from "./log.mjs";

const MODULE_ID = "foundryvtt-oidc-logout";
const SRC_DIR = "/opt/oidc/foundry-module";
const DEST_PARENT = "/data/Data/modules";

// Foundry stores a world's enabled-modules map in the `core.moduleConfiguration`
// world setting: { [moduleId]: true|false }. Setting it to true (and having the
// module on disk) is enough to make Foundry load it on next world launch.
const SETTING_KEY = "core.moduleConfiguration";

async function copyDirRecursive(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDirRecursive(s, d);
    else await fs.copyFile(s, d);
  }
}

export async function installLogoutModule() {
  // 1) Copy module dir into /data/Data/modules/<id> so Foundry sees it.
  try {
    await fs.access(SRC_DIR);
  } catch {
    log.debug(`logout module source ${SRC_DIR} missing; skip install`);
    return;
  }
  const dest = path.join(DEST_PARENT, MODULE_ID);
  try {
    await copyDirRecursive(SRC_DIR, dest);
    log.info(`logout module copied to ${dest}`);
  } catch (e) {
    log.warn(`logout module copy to ${dest} failed: ${e.message}`);
    return;
  }

  // 2) Auto-enable in the active world's settings. The Setting DB
  // isn't ready until Foundry finishes launching the world (which
  // happens *after* the shim binds routes), so wait for it in the
  // background — don't block bootstrap.
  enableInActiveWorldWhenReady().catch((e) =>
    log.warn(`auto-enable failed: ${e.message}`),
  );
}

const READY_POLL_MS = 500;
const READY_TIMEOUT_MS = 120_000;

async function waitForSettingDbReady() {
  const started = Date.now();
  while (Date.now() - started < READY_TIMEOUT_MS) {
    const cls = globalThis.config?.db?.Setting;
    const worldActive = globalThis.game?.active !== false;
    const dbReady =
      cls && (cls.ready === undefined || cls.ready === true) &&
      (cls.connected === undefined || cls.connected === true);
    if (cls && dbReady && worldActive) return cls;
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  return null;
}

async function enableInActiveWorldWhenReady() {
  const SettingCls = await waitForSettingDbReady();
  if (!SettingCls) {
    log.warn(
      `Setting DB never ready; enable '${MODULE_ID}' once via Settings > Manage Modules.`,
    );
    return;
  }

  // Find the existing world setting if any. Foundry's Setting documents
  // are keyed by `key`; the value is a JSON-stringified object.
  let existing = null;
  if (typeof SettingCls.findOne === "function") {
    try {
      existing = await SettingCls.findOne({ key: SETTING_KEY });
    } catch (e) {
      log.debug(`Setting.findOne(${SETTING_KEY}) failed: ${e.message}`);
    }
  }

  let cfg = {};
  if (existing) {
    try {
      cfg = typeof existing.value === "string"
        ? JSON.parse(existing.value)
        : (existing.value || {});
    } catch {
      cfg = {};
    }
  }

  if (cfg[MODULE_ID] === true) {
    log.debug(`module '${MODULE_ID}' already enabled in ${SETTING_KEY}`);
    return;
  }
  cfg[MODULE_ID] = true;
  const newValue = JSON.stringify(cfg);

  if (existing) {
    try {
      if (typeof existing.update === "function") {
        await existing.update({ value: newValue });
      } else if (
        typeof existing.updateSource === "function" &&
        typeof existing.save === "function"
      ) {
        existing.updateSource({ value: newValue });
        await existing.save();
      } else {
        throw new Error("Setting document has no update path");
      }
      log.info(
        `enabled '${MODULE_ID}' in core.moduleConfiguration (existing setting updated)`,
      );
    } catch (e) {
      log.warn(
        `could not auto-enable '${MODULE_ID}' (update failed: ${e.message}); enable once via Settings > Manage Modules.`,
      );
    }
    return;
  }

  if (typeof SettingCls.create === "function") {
    try {
      await SettingCls.create({ key: SETTING_KEY, value: newValue });
      log.info(`created core.moduleConfiguration with '${MODULE_ID}'=true`);
    } catch (e) {
      log.warn(
        `could not create core.moduleConfiguration (${e.message}); enable '${MODULE_ID}' once via Settings > Manage Modules.`,
      );
    }
    return;
  }

  log.warn(
    `Setting.create unavailable; enable '${MODULE_ID}' once via Settings > Manage Modules.`,
  );
}
