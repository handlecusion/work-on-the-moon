'use strict';

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const { v4: uuidv4 } = require('uuid');
const store = require('./store');

const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:3700';
const RP_NAME = 'Claude Code Web';

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 min

// ---- base64url helpers (compatible with @simplewebauthn v9) ----
function toB64u(buf) {
  if (buf == null) return '';
  if (typeof buf === 'string') return buf;
  if (buf instanceof Uint8Array) buf = Buffer.from(buf);
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromB64u(s) {
  if (!s) return Buffer.alloc(0);
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// @simplewebauthn/server v9 returns options with `challenge` as a string but
// leaves `user.id` and credential ids as Uint8Array/Buffer. We must serialize
// every binary field to base64url so that the JSON we send to the browser
// matches WebAuthn's wire format and the client can decode without errors.
function serializeOptionsForWire(options) {
  const out = Object.assign({}, options);
  if (out.challenge != null && typeof out.challenge !== 'string') {
    out.challenge = toB64u(out.challenge);
  }
  if (out.user) {
    out.user = Object.assign({}, out.user);
    if (out.user.id != null && typeof out.user.id !== 'string') {
      out.user.id = toB64u(out.user.id);
    }
  }
  if (Array.isArray(out.excludeCredentials)) {
    out.excludeCredentials = out.excludeCredentials.map(c => Object.assign({}, c, {
      id: typeof c.id === 'string' ? c.id : toB64u(c.id)
    }));
  }
  if (Array.isArray(out.allowCredentials)) {
    out.allowCredentials = out.allowCredentials.map(c => Object.assign({}, c, {
      id: typeof c.id === 'string' ? c.id : toB64u(c.id)
    }));
  }
  return out;
}

function storeChallenge(challenge, type) {
  const id = uuidv4();
  return store.update((data) => {
    data.currentChallenges[id] = {
      challenge,
      type,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()
    };
    return id;
  });
}

function takeChallenge(id, expectedType) {
  return store.update((data) => {
    const c = data.currentChallenges[id];
    if (!c) return null;
    delete data.currentChallenges[id];
    if (Date.parse(c.expiresAt) <= Date.now()) return null;
    if (expectedType && c.type !== expectedType) return null;
    return c.challenge;
  });
}

async function buildRegistrationOptions({ userName, excludeExistingCredentials = false }) {
  const data = store.getData();
  const userID = Buffer.from('claude-web-user', 'utf8'); // single-user instance

  const excludeCredentials = excludeExistingCredentials
    ? data.passkeys.map(pk => ({
        id: fromB64u(pk.id),
        type: 'public-key',
        transports: pk.transports || []
      }))
    : [];

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID,
    userName: userName || 'claude-web',
    userDisplayName: userName || 'Claude Web',
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred'
    },
    supportedAlgorithmIDs: [-7, -257]
  });

  const challengeId = await storeChallenge(
    typeof options.challenge === 'string' ? options.challenge : toB64u(options.challenge),
    'registration'
  );
  return { options: serializeOptionsForWire(options), challengeId };
}

async function verifyRegistration({ response, challengeId, deviceName }) {
  const expectedChallenge = await takeChallenge(challengeId, 'registration');
  if (!expectedChallenge) {
    return { verified: false, error: '챌린지가 만료되었거나 유효하지 않습니다.' };
  }
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false
    });
  } catch (e) {
    return { verified: false, error: e.message };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { verified: false, error: '검증 실패' };
  }
  const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
  const idB64u = toB64u(credentialID);
  const pkB64u = toB64u(credentialPublicKey);
  const transports = (response && response.response && response.response.transports) || ['internal'];
  await store.update((data) => {
    // Avoid duplicates
    data.passkeys = data.passkeys.filter(p => p.id !== idB64u);
    data.passkeys.push({
      id: idB64u,
      publicKey: pkB64u,
      counter: counter || 0,
      transports,
      name: deviceName || 'Unnamed device',
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    });
  });
  return { verified: true, credentialId: idB64u };
}

async function buildAuthenticationOptions() {
  const data = store.getData();
  const allowCredentials = data.passkeys.map(pk => ({
    id: fromB64u(pk.id),
    type: 'public-key',
    transports: pk.transports || []
  }));
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials,
    userVerification: 'preferred'
  });
  const challengeId = await storeChallenge(
    typeof options.challenge === 'string' ? options.challenge : toB64u(options.challenge),
    'authentication'
  );
  return { options: serializeOptionsForWire(options), challengeId };
}

async function verifyAuthentication({ response, challengeId }) {
  const expectedChallenge = await takeChallenge(challengeId, 'authentication');
  if (!expectedChallenge) {
    return { verified: false, error: '챌린지가 만료되었거나 유효하지 않습니다.' };
  }
  const data = store.getData();
  const credIdB64u = response && response.id;
  if (!credIdB64u) return { verified: false, error: '자격증명 ID 누락' };
  const passkey = data.passkeys.find(p => p.id === credIdB64u);
  if (!passkey) return { verified: false, error: '등록되지 않은 패스키' };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      authenticator: {
        credentialID: fromB64u(passkey.id),
        credentialPublicKey: fromB64u(passkey.publicKey),
        counter: passkey.counter || 0,
        transports: passkey.transports || []
      },
      requireUserVerification: false
    });
  } catch (e) {
    return { verified: false, error: e.message };
  }

  if (!verification.verified) return { verified: false, error: '검증 실패' };

  await store.update((data2) => {
    const pk = data2.passkeys.find(p => p.id === passkey.id);
    if (pk) {
      pk.counter = verification.authenticationInfo.newCounter || pk.counter;
      pk.lastUsedAt = new Date().toISOString();
    }
  });

  return { verified: true, passkeyId: passkey.id, passkeyName: passkey.name };
}

module.exports = {
  RP_ID,
  ORIGIN,
  RP_NAME,
  toB64u,
  fromB64u,
  buildRegistrationOptions,
  verifyRegistration,
  buildAuthenticationOptions,
  verifyAuthentication
};
