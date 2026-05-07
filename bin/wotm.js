#!/usr/bin/env node
'use strict';

// `wotm` — npx entry point for work-on-the-moon.
//
// Recommended deployment: behind Cloudflare Tunnel or Tailscale Funnel — see
// the "External access setup" section of the README. WebAuthn requires a
// stable hostname with HTTPS, so multi-device use means a tunnel.
//
// Subcommands:
//   wotm                run server in foreground
//   wotm reset          wipe ~/.wotm state (handled by server.js)
//   wotm install        write + load a LaunchAgent so wotm autostarts at login
//   wotm uninstall      unload + remove the LaunchAgent
//   wotm status         show LaunchAgent state

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const SERVER_JS = path.join(PKG_ROOT, 'server.js');
const LABEL = 'com.work-on-the-moon';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_DIR = path.join(os.homedir(), '.wotm');

const args = process.argv.slice(2);
const cmd = args[0];

switch (cmd) {
  case 'install':   cmdInstall(args.slice(1)); break;
  case 'uninstall': cmdUninstall(); break;
  case 'status':    cmdStatus(); break;
  case 'help':
  case '--help':
  case '-h':        cmdHelp(); break;
  default:          runServer();
}

function runServer() {
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

  require(SERVER_JS);
}

function cmdInstall(rest) {
  requireDarwin('install');
  const flags = parseFlags(rest);
  const origin = flags.origin || process.env.ORIGIN;
  const rpId = flags['rp-id'] || flags.rpid || process.env.RP_ID;
  if (!origin || !rpId) {
    console.error('[wotm] install requires --origin=https://your.host --rp-id=your.host');
    console.error('       (or set ORIGIN and RP_ID env vars before running)');
    process.exit(1);
  }
  const port = String(flags.port || process.env.PORT || '3700');
  const host = String(flags.host || process.env.HOST || '127.0.0.1');

  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const plist = buildPlist({ origin, rpId, port, host });
  fs.writeFileSync(PLIST_PATH, plist);
  console.log(`[wotm] wrote ${PLIST_PATH}`);

  const uid = process.getuid();
  // Idempotent: bootout any existing copy before bootstrapping the new one.
  spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });

  let r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST_PATH], { stdio: 'inherit' });
  if (r.status !== 0) {
    // Fallback for older macOS where bootstrap is unavailable or restricted.
    r = spawnSync('launchctl', ['load', '-w', PLIST_PATH], { stdio: 'inherit' });
  }
  if (r.status !== 0) {
    console.error('[wotm] failed to load LaunchAgent — see error above');
    process.exit(1);
  }

  console.log(`[wotm] loaded ${LABEL} — wotm will autostart at login`);
  console.log(`[wotm] origin: ${origin}`);
  console.log(`[wotm] logs:   ${path.join(LOG_DIR, 'launchd.{out,err}.log')}`);
  console.log('[wotm] re-run `wotm install ...` after upgrading or moving the node binary');
}

function cmdUninstall() {
  requireDarwin('uninstall');
  const uid = process.getuid();
  let unloaded = false;

  let r = spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'pipe' });
  if (r.status === 0) unloaded = true;
  else if (fs.existsSync(PLIST_PATH)) {
    r = spawnSync('launchctl', ['unload', '-w', PLIST_PATH], { stdio: 'pipe' });
    if (r.status === 0) unloaded = true;
  }

  if (fs.existsSync(PLIST_PATH)) {
    fs.unlinkSync(PLIST_PATH);
    console.log(`[wotm] removed ${PLIST_PATH}`);
  }
  console.log(unloaded
    ? `[wotm] unloaded ${LABEL}`
    : `[wotm] ${LABEL} was not loaded`);
}

function cmdStatus() {
  requireDarwin('status');
  const exists = fs.existsSync(PLIST_PATH);
  console.log(`plist:   ${PLIST_PATH} ${exists ? '(exists)' : '(missing)'}`);

  const uid = process.getuid();
  const r = spawnSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { encoding: 'utf8' });
  if (r.status === 0) {
    const stateMatch = r.stdout.match(/state\s*=\s*(\S+)/);
    const pidMatch = r.stdout.match(/\bpid\s*=\s*(\d+)/);
    const parts = ['loaded'];
    if (stateMatch) parts.push(`state=${stateMatch[1]}`);
    if (pidMatch) parts.push(`pid=${pidMatch[1]}`);
    console.log(`launchd: ${parts.join(' ')}`);
  } else {
    console.log('launchd: not loaded');
  }
  console.log(`logs:    ${path.join(LOG_DIR, 'launchd.{out,err}.log')}`);
}

function cmdHelp() {
  console.log(`wotm — work-on-the-moon

Usage:
  wotm                              Run server in foreground (default)
  wotm reset                        Wipe ~/.wotm state
  wotm install --origin=URL --rp-id=HOST [--port=N] [--host=ADDR]
                                    Install LaunchAgent (autostart at login)
  wotm uninstall                    Unload + remove LaunchAgent
  wotm status                       Show LaunchAgent status

\`install\` captures the current node binary path, PATH, and any
WORKSPACE_DIR/CLAUDE_BIN/CMUX_* env vars into ~/Library/LaunchAgents/
${LABEL}.plist. Re-run after upgrading node or
moving the package install location.
`);
}

function buildPlist({ origin, rpId, port, host }) {
  const username = os.userInfo().username;
  const env = {
    PORT: port,
    HOST: host,
    NODE_ENV: 'production',
    ORIGIN: origin,
    RP_ID: rpId,
    HOME: os.homedir(),
    USER: username,
    LOGNAME: username,
    SHELL: process.env.SHELL || '/bin/zsh',
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  };
  for (const k of [
    'WORKSPACE_DIR', 'CLAUDE_BIN',
    'CMUX_BUNDLE_ID', 'CMUX_CLAUDE_HOOK_CMUX_BIN', 'CMUX_SOCKET_PATH',
  ]) {
    if (process.env[k]) env[k] = process.env[k];
  }

  const envXml = Object.entries(env).map(([k, v]) =>
    `        <key>${esc(k)}</key>\n        <string>${esc(v)}</string>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${esc(process.execPath)}</string>
        <string>${esc(SERVER_JS)}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${esc(PKG_ROOT)}</string>

    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>StandardOutPath</key>
    <string>${esc(path.join(LOG_DIR, 'launchd.out.log'))}</string>

    <key>StandardErrorPath</key>
    <string>${esc(path.join(LOG_DIR, 'launchd.err.log'))}</string>

    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
`;
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    if (m[2] !== undefined) {
      out[key] = m[2];
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      out[key] = argv[++i];
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function esc(s) {
  return String(s).replace(/[<>&'"]/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

function requireDarwin(op) {
  if (process.platform !== 'darwin') {
    console.error(`[wotm] ${op}: only macOS (LaunchAgent) is supported`);
    process.exit(1);
  }
}
