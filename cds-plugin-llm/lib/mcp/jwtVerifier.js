// JWKS-based JWT verifier for MCP bearer tokens. Standard OAuth2/OIDC path:
//   1. Client presents `Authorization: Bearer <jwt>`
//   2. Server fetches JWKS from the configured URL (cached with TTL)
//   3. Verifies signature, exp, iat, nbf against the matching public key (by kid)
//   4. Optionally validates issuer and audience claims
//
// Works with any standards-compliant IdP: SAP XSUAA, Auth0, Okta, Azure AD,
// Google, Keycloak, AWS Cognito, Zitadel, etc.
//
// Uses `jose` (loaded lazily to keep it an optional dep — install with
// `npm install jose` in your CAP app if you want JWT auth on the MCP server).

/**
 * Build an authTokenVerifier suitable for `createHttpTransport({ authTokenVerifier })`.
 *
 *   const verifier = createJwtVerifier({
 *     jwksUrl:  'https://tenant.authentication.us10.hana.ondemand.com/token_keys',
 *     issuer:   'https://tenant.authentication.us10.hana.ondemand.com',
 *     audience: 'sb-my-cap-app!t12345',
 *   });
 *   createHttpTransport({ server, authTokenVerifier: verifier });
 *
 * The returned verifier is `async (token) => claims | null`.
 * Returns null on any failure (missing kid, bad signature, expired, wrong iss/aud, etc.).
 */
function createJwtVerifier(options = {}) {
  const { jwksUrl, issuer, audience } = options;
  if (!jwksUrl) throw new Error('createJwtVerifier: jwksUrl is required');

  let jose;
  try { jose = require('jose'); }
  catch (e) {
    throw new Error(
      "createJwtVerifier requires the optional 'jose' peer dep. Install with: `npm install jose`. " +
      "This dep is only needed when using MCP JWT/JWKS authentication."
    );
  }

  // Reuse the jose remote JWKS getter — it caches keys and refreshes on
  // unknown kid, exactly the behavior we want.
  const JWKS = jose.createRemoteJWKSet(new URL(jwksUrl));

  return async function verifyToken(token) {
    try {
      const verifyOpts = {};
      if (issuer) verifyOpts.issuer = issuer;
      if (audience) verifyOpts.audience = audience;
      const { payload } = await jose.jwtVerify(token, JWKS, verifyOpts);
      return payload;
    } catch (_err) {
      // jose throws with typed errors for expired / bad-sig / wrong-iss etc;
      // we intentionally collapse all failure modes to null so the transport
      // returns a uniform 401 (avoids leaking whether the token was expired
      // vs. tampered — same rationale as constant-time bearer compare).
      return null;
    }
  };
}

module.exports = { createJwtVerifier };
