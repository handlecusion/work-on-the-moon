#!/usr/bin/env node
'use strict';

// `wotm` — npx entry point for work-on-the-moon.
//
// Recommended deployment: behind Cloudflare Tunnel or Tailscale Funnel — see
// the "External access setup" section of the README. WebAuthn requires a
// stable hostname with HTTPS, so multi-device use means a tunnel.
//
// If ORIGIN/RP_ID are unset we fall through to localhost as a test bench —
// useful to verify the install before wiring a tunnel, but not for daily use.

const path = require('path');

const PORT = process.env.PORT || '3700';
if (!process.env.HOST) process.env.HOST = '127.0.0.1';
if (!process.env.PORT) process.env.PORT = PORT;

const TUNNEL_MODE = !!(process.env.ORIGIN && process.env.RP_ID);
if (!process.env.ORIGIN) process.env.ORIGIN = `http://localhost:${PORT}`;
if (!process.env.RP_ID) process.env.RP_ID = 'localhost';

if (TUNNEL_MODE) {
  console.log(`[wotm] tunnel mode — RP_ID=${process.env.RP_ID}`);
} else {
  console.log('[wotm] localhost test mode — passkeys registered here are NOT portable');
  console.log('[wotm] for multi-device use, set ORIGIN + RP_ID to a tunnel hostname');
  console.log('[wotm] guides: https://github.com/handlecusion/work-on-the-moon#external-access-setup');
}

require(path.join(__dirname, '..', 'server.js'));
