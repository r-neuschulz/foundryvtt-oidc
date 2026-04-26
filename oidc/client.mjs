import { Issuer, generators } from "openid-client";
import { log } from "./log.mjs";

let cachedClient = null;

export async function getOidcClient(cfg) {
  if (cachedClient) return cachedClient;

  log.info(`discovering issuer: ${cfg.issuer}`);
  const issuer = await Issuer.discover(cfg.issuer);
  log.info(
    `issuer discovered: authz=${issuer.metadata.authorization_endpoint} token=${issuer.metadata.token_endpoint}`,
  );

  cachedClient = new issuer.Client({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uris: [cfg.redirectUri],
    response_types: ["code"],
  });

  return cachedClient;
}

export { generators };
