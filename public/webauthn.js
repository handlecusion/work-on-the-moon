// Shared WebAuthn client helpers (no build step).
// @simplewebauthn/server v9 emits options with base64url-encoded buffers and
// expects responses with base64url-encoded buffers.
(function (root) {
  function b64uToBytes(s) {
    if (!s) return new Uint8Array(0);
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (s.length % 4)) % 4;
    s += '='.repeat(pad);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64u(buf) {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function prepareRegOptions(options) {
    const o = Object.assign({}, options);
    o.challenge = b64uToBytes(options.challenge);
    o.user = Object.assign({}, options.user, { id: b64uToBytes(options.user.id) });
    if (Array.isArray(options.excludeCredentials)) {
      o.excludeCredentials = options.excludeCredentials.map(c => Object.assign({}, c, {
        id: b64uToBytes(c.id)
      }));
    }
    return o;
  }

  function prepareAuthOptions(options) {
    const o = Object.assign({}, options);
    o.challenge = b64uToBytes(options.challenge);
    if (Array.isArray(options.allowCredentials)) {
      o.allowCredentials = options.allowCredentials.map(c => Object.assign({}, c, {
        id: b64uToBytes(c.id)
      }));
    }
    return o;
  }

  function serializeAttestation(cred) {
    const r = cred.response;
    const out = {
      id: cred.id,
      rawId: bytesToB64u(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bytesToB64u(r.clientDataJSON),
        attestationObject: bytesToB64u(r.attestationObject)
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
    };
    if (typeof r.getTransports === 'function') {
      try { out.response.transports = r.getTransports(); } catch (_) {}
    }
    if (typeof r.getAuthenticatorData === 'function') {
      try { out.response.authenticatorData = bytesToB64u(r.getAuthenticatorData()); } catch (_) {}
    }
    if (typeof r.getPublicKey === 'function') {
      try {
        const pk = r.getPublicKey();
        if (pk) out.response.publicKey = bytesToB64u(pk);
      } catch (_) {}
    }
    if (typeof r.getPublicKeyAlgorithm === 'function') {
      try { out.response.publicKeyAlgorithm = r.getPublicKeyAlgorithm(); } catch (_) {}
    }
    return out;
  }

  function serializeAssertion(cred) {
    const r = cred.response;
    return {
      id: cred.id,
      rawId: bytesToB64u(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bytesToB64u(r.clientDataJSON),
        authenticatorData: bytesToB64u(r.authenticatorData),
        signature: bytesToB64u(r.signature),
        userHandle: r.userHandle ? bytesToB64u(r.userHandle) : undefined
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
    };
  }

  root.WebAuthnUtil = {
    b64uToBytes, bytesToB64u,
    prepareRegOptions, prepareAuthOptions,
    serializeAttestation, serializeAssertion
  };
})(window);
