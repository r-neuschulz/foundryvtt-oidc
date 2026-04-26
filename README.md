# foundryvtt-oidc

Drop-in OIDC SSO for [Foundry VTT](https://foundryvtt.com), built as a thin Docker image on top of [`felddy/foundryvtt`](https://github.com/felddy/foundryvtt-docker). Designed for Keycloak but works with any spec-compliant OIDC provider that publishes a `.well-known/openid-configuration` document.

The goal is **minimum config**: paste your issuer URL, client ID, and client secret as env vars; users authenticate against your IdP and land in Foundry. Identities are managed in Keycloak; Foundry is just the consumer.

## Why this exists

Foundry modules cannot intercept the `/join` page — the module API runs only inside the game view, not the auth flow. That makes a "real" OIDC integration impossible as a pure module. This project takes the only other clean path: a tiny Node ESM shim that is loaded into the Foundry server process via `NODE_OPTIONS=--import`, hooks Foundry's Express app at boot, and adds OIDC routes.

The shim does not modify any Foundry source files on disk. It runs alongside Foundry's own code in the same process.

## Quickstart

1. Copy `.env.example` to `.env` and fill in your Foundry credentials and OIDC client secret.
2. Edit `docker-compose.example.yml`: replace `keycloak.example.com` and `foundry.example.com` with your hostnames; set `OIDC_GM_GROUPS` to the Keycloak group(s) whose members should be GMs.
3. `docker compose -f docker-compose.example.yml up -d --build`
4. Visit `https://foundry.example.com/` — you'll be redirected to Keycloak.

## Configuration

All configuration lives in environment variables. Required:

| Var | Description |
|---|---|
| `OIDC_ISSUER` | Issuer URL. For Keycloak: `https://<host>/realms/<realm>`. The shim discovers endpoints from `${OIDC_ISSUER}/.well-known/openid-configuration`. |
| `OIDC_CLIENT_ID` | OIDC client ID configured in your IdP. |
| `OIDC_CLIENT_SECRET` | OIDC client secret. |
| `OIDC_REDIRECT_URI` | Must match the redirect URI configured in your IdP. Use `https://<your-foundry>/oidc/callback`. |

Optional:

| Var | Default | Description |
|---|---|---|
| `OIDC_SCOPES` | `openid profile email groups` | Space-separated scopes requested. |
| `OIDC_USERNAME_CLAIM` | `preferred_username` | ID token claim used as the Foundry username. |
| `OIDC_GROUPS_CLAIM` | `groups` | ID token claim containing the user's groups. |
| `OIDC_GM_GROUPS` | *(empty)* | Comma-separated group names. Members are auto-assigned the GAMEMASTER role on first login. |
| `OIDC_AUTO_REDIRECT` | `true` | If true, `GET /join` redirects to `/oidc/login` automatically. Disable to keep Foundry's native form. |
| `OIDC_BYPASS_QUERY` | `local` | Query parameter that bypasses the auto-redirect: `/join?local=1` shows the native form (escape hatch for admins). |
| `OIDC_COOKIE_NAME` | `oidc_state` | Name of the signed cookie holding state/nonce/PKCE between login and callback. |
| `OIDC_COOKIE_SECURE` | `true` | Set `Secure` flag on cookies. Set `false` only for local HTTP testing. |
| `OIDC_DEBUG` | `false` | Verbose logging plus a one-time dump of `globalThis` keys after Foundry starts (useful for diagnosing version-specific quirks). |

## Setting up the Keycloak client

1. Realm → **Clients** → **Create client**.
2. Client type: **OpenID Connect**, Client ID: `foundry-vtt` (must match `OIDC_CLIENT_ID`).
3. Capability config: **Client authentication: On**, **Authorization: Off**, **Standard flow: On**, all others off.
4. Login settings: **Valid redirect URIs**: `https://<your-foundry>/oidc/callback`. **Valid post-logout redirect URIs**: `https://<your-foundry>/`.
5. Save → **Credentials** tab → copy the secret into `OIDC_CLIENT_SECRET`.
6. (Optional) For GM auto-promotion: Realm → **Groups** → create a group (e.g. `foundry-gms`). Then **Client scopes** → `<client-id>-dedicated` → **Add mapper → Group Membership**: name `groups`, token claim `groups`, full path **off**, add to ID token: **on**. Add the same group claim mapper to the access token if your downstream cares.

That's the whole IdP-side setup. Foundry-side, all you do is set the four env vars.

## Identity mapping

- The OIDC `preferred_username` claim (configurable via `OIDC_USERNAME_CLAIM`) maps to the Foundry user's `name` field.
- On first login, the shim attempts to **auto-create** the matching Foundry user using whichever User-creation API is available in the running Foundry version. If the Foundry version doesn't expose a usable API, the shim shows a friendly error page asking the admin to create the user manually in `/players` once. Subsequent logins for that user then work without intervention. (See *Caveats* below.)
- Members of any group listed in `OIDC_GM_GROUPS` get role `GAMEMASTER` (4); everyone else defaults to `PLAYER` (1).
- Role re-evaluation happens only at user-creation time. Promoting an existing Foundry user to GM after the fact is still done in Foundry's `/players` UI — that's a deliberate scope choice (the shim never *demotes* a user it didn't create, to avoid clobbering manual admin changes).

## How it works

1. The image is `FROM felddy/foundryvtt:release`. We add `/opt/oidc/` containing the shim + its single npm dep (`openid-client`), and set `NODE_OPTIONS=--import file:///opt/oidc/shim.mjs`.
2. Node loads `shim.mjs` *before* Foundry's `main.mjs`. The shim immediately starts polling `globalThis.config.express` (set by Foundry during boot).
3. Once the Express app is up, the shim:
   - Registers `GET /oidc/login`, `GET /oidc/callback`, `GET /oidc/logout`, `GET /oidc/health`.
   - Promotes those routes to the front of the Express router stack so they take precedence.
   - Optionally registers a `GET /join` interceptor that 302s to `/oidc/login`.
4. On callback success, the shim looks up (or creates) the matching Foundry user, mints a Foundry session by writing into `globalThis.config.auth.sessions`, sets the session cookie, and redirects to `/game`.

The shim never touches Foundry's source files. If anything breaks, the OIDC integration just doesn't load — Foundry's native login still works, and you can always reach it directly via `/join?local=1`.

## Caveats

- **Foundry version targeting.** Tested anchors: `globalThis.config.express`, `globalThis.config.auth.sessions`, the Foundry user/role schema. These have been stable since v11 but are not officially documented APIs. Set `OIDC_DEBUG=1` if something doesn't bind correctly and file an issue with the log output.
- **Auto-creation is best-effort.** The shim probes several plausible User-creation paths and falls back to a clear error page if none work. Once a user has been created (manually or automatically), subsequent logins are straightforward.
- **Foundry license.** This image inherits felddy's licensing flow (you provide your Foundry username/password or a presigned release URL via build args / env vars). It downloads Foundry binaries the same way the upstream image does; we ship no Foundry code.
- **EULA.** This image does not modify Foundry's distributed code. It loads alongside Foundry's process and registers additional Express routes, similar to how a Foundry module would extend the client. Whether your deployment is acceptable to the Foundry EULA is your call.
- **Admin escape hatch.** If you misconfigure OIDC and lock yourself out, hit `/join?local=1` (or whatever you set `OIDC_BYPASS_QUERY` to) to reach Foundry's native form, or unset the OIDC env vars and restart.

## Development

```sh
docker build -t foundryvtt-oidc:dev .
```

The shim is plain Node ESM; you can `node --check oidc/shim.mjs` to validate syntax without booting the full image.

## License

MIT. See [LICENSE](LICENSE).

Author: r-neuschulz. Not affiliated with Foundry Gaming LLC, Keycloak, or felddy.
