'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const store = require('./auth/store');
const session = require('./auth/session');

const authRouter = require('./routes/auth');
const setupRouter = require('./routes/setup');
const devicesRouter = require('./routes/devices');
const projectsModule = require('./routes/projects');
const fs = require('fs');
const chatModule = require('./routes/chat');
const liveModule = require('./routes/live');
const slashRouter = require('./routes/slash');
const sessionsRouter = require('./routes/sessions');

const PORT = parseInt(process.env.PORT, 10) || 3700;
const HOST = process.env.HOST || '127.0.0.1';
const ORIGIN = process.env.ORIGIN || `http://localhost:${PORT}`;

// ---- CLI: `node server.js reset` ----
async function runReset() {
  store.loadSync();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await store.update((data) => {
    data.passkeys = [];
    data.sessions = [];
    data.currentChallenges = {};
    data.registrationTokens = [{ token, expiresAt, used: false }];
    data.setupCompleted = false;
  });
  printSetupBanner(token);
  process.exit(0);
}

function printSetupBanner(token) {
  const url = ORIGIN.replace(/\/$/, '') + '/setup?token=' + token;
  const line = '==============================';
  console.log('');
  console.log(line);
  console.log('Initial passkey registration URL (valid for 10 minutes)');
  console.log('초기 패스키 등록 URL (10분 유효)');
  console.log(url);
  console.log(line);
  console.log('');
}

async function ensureBootstrapToken() {
  const data = store.getData();
  if (data.setupCompleted) return;
  // Reuse a valid existing token if present, else create one.
  const now = Date.now();
  let valid = data.registrationTokens.find(t => !t.used && Date.parse(t.expiresAt) > now);
  if (!valid) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(now + 10 * 60 * 1000).toISOString();
    await store.update((d) => {
      d.registrationTokens.push({ token, expiresAt, used: false });
    });
    valid = { token };
  }
  printSetupBanner(valid.token);
}

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind cloudflared
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // No-cache for HTML so users always get fresh markup; static assets validate via ETag/Last-Modified.
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Static (only assets — index.html etc. are served via specific routes that auth-check)
  // We do NOT use express.static for the protected pages; instead serve them through routed handlers.
  // no-store on JS/CSS to defeat iOS Safari's BFCache, which restores stale
  // pages with old click handlers and silently bypasses Cache-Control.
  app.use('/static', express.static(path.join(__dirname, 'public'), {
    fallthrough: true,
    index: false,
    etag: false,
    lastModified: false,
    setHeaders: (res) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); }
  }));
  // Allow CSS without auth
  app.get('/style.css', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'style.css'));
  });

  // Public routes
  app.get('/login', (req, res) => {
    // If already authed, go home
    if (session.getSessionFromReq(req)) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  app.use('/api/auth', authRouter);
  app.use(setupRouter); // /setup + /api/setup/*
  app.use(devicesRouter); // /devices + /api/devices/*
  app.use(projectsModule.router);
  app.use(chatModule.router); // /chat/:name
  app.use(liveModule.router); // /chat-live/:sessionId + /api/live/:sessionId
  app.use(slashRouter);       // /api/slash-commands
  app.use(sessionsRouter);    // /api/sessions

  // Root: auth or redirect to login
  app.get('/', (req, res) => {
    const s = session.getSessionFromReq(req);
    if (!s) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Health
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Fallback 404
  app.use((req, res) => {
    res.status(404).send('Not found');
  });

  // Error handler
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

async function main() {
  if (process.argv[2] === 'reset') {
    await runReset();
    return;
  }

  store.loadSync();
  await store.pruneAndPersist();
  await ensureBootstrapToken();

  const app = buildApp();
  const server = http.createServer(app);
  chatModule.attachWS(server);
  liveModule.attachWS(server);

  server.listen(PORT, HOST, () => {
    console.log(`[claude-web] listening on http://${HOST}:${PORT}`);
    console.log(`[claude-web] origin:    ${ORIGIN}`);
    console.log(`[claude-web] workspace: ${projectsModule.CODE_DIR}`);
    if (!fs.existsSync(projectsModule.CODE_DIR)) {
      console.warn(`[claude-web] WARN: workspace directory does not exist — set WORKSPACE_DIR to the folder that contains your projects.`);
    }
  });

  // Periodically prune expired records
  setInterval(() => {
    store.pruneAndPersist().catch((e) => console.error('[prune]', e.message));
  }, 5 * 60 * 1000).unref();
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
