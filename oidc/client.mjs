import * as oidc from "openid-client";
import { log } from "./log.mjs";

let cachedConfig = null;

export async function getOidcConfig(cfg) {
  if (cachedConfig) return cachedConfig;

  log.info(`discovering issuer: ${cfg.issuer}`);
  const config = await oidc.discovery(
    new URL(cfg.issuer),
    cfg.clientId,
    cfg.clientSecret,
  );
  const md = config.serverMetadata();
  log.info(
    `issuer discovered: authz=${md.authorization_endpoint} token=${md.token_endpoint}`,
  );

  cachedConfig = config;
  return cachedConfig;
}

export { oidc };
