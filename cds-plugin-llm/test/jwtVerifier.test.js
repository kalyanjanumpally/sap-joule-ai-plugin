const { test } = require('node:test');
const assert = require('node:assert/strict');

// Mock the `jose` module BEFORE requiring the verifier so the require inside
// the verifier picks up the stub. jose is an optional dep — stubbing it lets
// us test the verifier's shape + option forwarding without pulling in the
// real crypto library.
const Module = require('module');
const JOSE_STUB_PATH = '/tmp/__jose_stub__';
const joseCalls = { verify: [], jwks: [] };
require.cache[JOSE_STUB_PATH] = {
  exports: {
    createRemoteJWKSet(url) {
      joseCalls.jwks.push({ url: url.toString() });
      return { __isJwks: true };
    },
    async jwtVerify(token, jwks, opts) {
      joseCalls.verify.push({ token, jwks, opts });
      if (token === 'good.token.here') {
        return { payload: { sub: 'user-123', iss: opts?.issuer ?? '', aud: opts?.audience ?? '' } };
      }
      if (token === 'expired.token.here') {
        const e = new Error('token expired'); e.code = 'ERR_JWT_EXPIRED'; throw e;
      }
      throw new Error('invalid');
    },
  },
  loaded: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  if (request === 'jose') return JOSE_STUB_PATH;
  return origResolve.call(this, request, ...rest);
};

const { createJwtVerifier } = require('../lib/mcp/jwtVerifier');

test('createJwtVerifier: requires jwksUrl', () => {
  assert.throws(() => createJwtVerifier({}), /jwksUrl is required/);
});

test('createJwtVerifier: initializes remote JWKS from url', () => {
  createJwtVerifier({ jwksUrl: 'https://idp.example.com/.well-known/jwks.json' });
  const last = joseCalls.jwks[joseCalls.jwks.length - 1];
  assert.equal(last.url, 'https://idp.example.com/.well-known/jwks.json');
});

test('createJwtVerifier: returns null on unknown / invalid token', async () => {
  const verify = createJwtVerifier({ jwksUrl: 'https://x/j' });
  assert.equal(await verify('nope'), null);
});

test('createJwtVerifier: returns null on any thrown error (uniform 401)', async () => {
  const verify = createJwtVerifier({ jwksUrl: 'https://x/j' });
  assert.equal(await verify('expired.token.here'), null);
});

test('createJwtVerifier: returns payload on valid token', async () => {
  const verify = createJwtVerifier({ jwksUrl: 'https://x/j' });
  const claims = await verify('good.token.here');
  assert.equal(claims.sub, 'user-123');
});

test('createJwtVerifier: forwards issuer and audience to jose.jwtVerify', async () => {
  const verify = createJwtVerifier({
    jwksUrl: 'https://x/j',
    issuer: 'https://issuer.example.com',
    audience: 'sb-my-app!t123',
  });
  await verify('good.token.here');
  const last = joseCalls.verify[joseCalls.verify.length - 1];
  assert.equal(last.opts.issuer, 'https://issuer.example.com');
  assert.equal(last.opts.audience, 'sb-my-app!t123');
});

test('createJwtVerifier: omits issuer/audience from opts when not provided', async () => {
  const verify = createJwtVerifier({ jwksUrl: 'https://x/j' });
  await verify('good.token.here');
  const last = joseCalls.verify[joseCalls.verify.length - 1];
  assert.equal(last.opts.issuer, undefined);
  assert.equal(last.opts.audience, undefined);
});
