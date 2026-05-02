'use strict';

const crypto = require('crypto');
const store = require('./store');

const COOKIE_NAME = 'claudeweb_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createSession({ deviceHint }) {
  const token = newToken();
  const now = Date.now();
  const session = {
    token,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    deviceHint: deviceHint || ''
  };
  await store.update((data) => { data.sessions.push(session); });
  return session;
}

async function destroySession(token) {
  if (!token) return;
  await store.update((data) => {
    data.sessions = data.sessions.filter(s => s.token !== token);
  });
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_MS
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function getSessionFromReq(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  return store.findSession(token);
}

function requireAuth(req, res, next) {
  const session = getSessionFromReq(req);
  if (!session) {
    if (req.accepts('html') && !req.path.startsWith('/api/')) {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.session = session;
  next();
}

// For WS upgrade — accepts cookie OR ?session=<token>
function getSessionForWS(req, urlObj) {
  // Try cookie header first
  let token = null;
  const cookieHeader = req.headers && req.headers.cookie;
  if (cookieHeader) {
    const parts = cookieHeader.split(/;\s*/);
    for (const p of parts) {
      const eq = p.indexOf('=');
      if (eq < 0) continue;
      const k = p.slice(0, eq).trim();
      const v = p.slice(eq + 1).trim();
      if (k === COOKIE_NAME) { token = decodeURIComponent(v); break; }
    }
  }
  if (!token && urlObj) {
    token = urlObj.searchParams.get('session');
  }
  if (!token) return null;
  return store.findSession(token);
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  newToken,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  getSessionFromReq,
  requireAuth,
  getSessionForWS
};
