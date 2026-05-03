'use strict';

const express = require('express');
const path = require('path');
const webauthn = require('../auth/webauthn');
const session = require('../auth/session');
const store = require('../auth/store');

const router = express.Router();

// Public page — but requires a valid registration token
router.get('/setup', (req, res) => {
  // Just serve the page; client will check token via /api/setup/options
  res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
});

router.post('/api/setup/options', async (req, res) => {
  const { token, deviceName } = req.body || {};
  const reg = store.findRegistrationToken(token);
  if (!reg) {
    return res.status(400).json({ error: '유효하지 않거나 만료된 링크입니다.' });
  }
  try {
    const { options, challengeId } = await webauthn.buildRegistrationOptions({
      userName: deviceName || 'wotm',
      excludeExistingCredentials: true
    });
    res.json({ options, challengeId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/setup/verify', async (req, res) => {
  const { token, response, challengeId, deviceName } = req.body || {};
  const reg = store.findRegistrationToken(token);
  if (!reg) {
    return res.status(400).json({ error: '유효하지 않거나 만료된 링크입니다.' });
  }
  if (!response || !challengeId) {
    return res.status(400).json({ error: '잘못된 요청' });
  }
  const result = await webauthn.verifyRegistration({
    response,
    challengeId,
    deviceName: (deviceName && deviceName.trim()) || '기기'
  });
  if (!result.verified) {
    return res.status(400).json({ error: result.error || '등록 실패' });
  }
  // Mark token as used; if first-time setup, flip setupCompleted; auto-login this device.
  let isFirst = false;
  await store.update((data) => {
    const t = data.registrationTokens.find(x => x.token === token);
    if (t) t.used = true;
    if (!data.setupCompleted) {
      data.setupCompleted = true;
      isFirst = true;
    }
  });

  // Auto sign in the new device (convenience)
  const ua = (req.headers['user-agent'] || '').slice(0, 200);
  const created = await session.createSession({
    deviceHint: ((deviceName && deviceName.trim()) || '기기') + ' / ' + ua
  });
  session.setSessionCookie(res, created.token);

  res.json({ ok: true, firstTime: isFirst });
});

module.exports = router;
