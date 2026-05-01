// Foundry's Log Out button does:
//   game.logOut() { window.location.href = getRoute("join"); }
// which our shim's /join interceptor short-circuits back into the game
// for an already-authenticated user. Replace it so the button instead
// hits /oidc/logout, which clears the Foundry session, calls
// sessions.logoutWorld(), and redirects to the IdP's end_session
// endpoint to also kill the Keycloak SSO cookie.
//
// Override at "init" so it's in place before any caller can fire
// (sidebar Log Out click, self role/password change, etc.).
Hooks.once("init", () => {
  if (typeof globalThis.game?.logOut !== "function") return;
  globalThis.game.logOut = function () {
    window.location.href = "/oidc/logout";
  };
  console.log("foundryvtt-oidc-logout | game.logOut() routed via /oidc/logout");
});
