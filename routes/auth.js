'use strict';

const express = require('express');
const webauthn = require('../auth/webauthn');
const session = require('../auth/session');
const store = require('../auth/store');

const router = express.Router();

router.post('/login/options', async (req, res) => {
  const data = store.getData();
  if (!data.passkeys.length) {
    return res.status(400).json({ error: '등록된 패스키가 없습니다. 초기 설정이 필요합니다.' });
  }
  try {
    const { options, challengeId } = await webauthn.buildAuthenticationOptions();
    res.json({ options, challengeId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login/verify', async (req, res) => {
  const { response, challengeId } = req.body || {};
  if (!response || !challengeId) {
    return res.status(400).json({ error: '잘못된 요청' });
  }
  const result = await webauthn.verifyAuthentication({ response, challengeId });
  if (!result.verified) {
    return res.status(401).json({ error: result.error || '인증 실패' });
  }
  const ua = (req.headers['user-agent'] || '').slice(0, 200);
  const created = await session.createSession({ deviceHint: result.passkeyName + ' / ' + ua });
  session.setSessionCookie(res, created.token);
  res.json({ ok: true });
});

router.post('/logout', async (req, res) => {
  const token = req.cookies && req.cookies[session.COOKIE_NAME];
  await session.destroySession(token);
  session.clearSessionCookie(res);
  res.json({ ok: true });
});

module.exports = router;
