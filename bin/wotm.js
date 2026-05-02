#!/usr/bin/env node
'use strict';

// `wotm` — npx entry point for work-on-the-moon.
//
// Defaults to localhost so first-run requires no domain or tunnel.
// WebAuthn (passkey) requires `localhost` as the RP_ID — do NOT use 127.0.0.1.

const path = require('path');

const PORT = process.env.PORT || '3700';
if (!process.env.HOST) process.env.HOST = '127.0.0.1';
if (!process.env.PORT) process.env.PORT = PORT;
if (!process.env.ORIGIN) process.env.ORIGIN = `http://localhost:${PORT}`;
if (!process.env.RP_ID) process.env.RP_ID = 'localhost';

require(path.join(__dirname, '..', 'server.js'));
