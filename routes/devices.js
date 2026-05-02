'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const session = require('../auth/session');
const store = require('../auth/store');

const router = express.Router();

router.get('/devices', session.requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'devices.html'));
});

router.get('/api/devices', session.requireAuth, (req, res) => {
  const data = store.getData();
  res.json({
    passkeys: data.passkeys.map(p => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      lastUsedAt: p.lastUsedAt,
      transports: p.transports
    }))
  });
});

router.post('/api/devices/invite', session.requireAuth, async (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await store.update((data) => {
    data.registrationTokens.push({ token, expiresAt, used: false });
  });
  const origin = process.env.ORIGIN || 'http://localhost:3700';
  const url = origin.replace(/\/$/, '') + '/setup?token=' + token;
  let qr = '';
  try {
    qr = await QRCode.toDataURL(url, { margin: 1, width: 320 });
  } catch (e) {
    // QR generation failure shouldn't break the API
    qr = '';
  }
  res.json({ url, qr, expiresAt });
});

router.delete('/api/devices/:id', session.requireAuth, async (req, res) => {
  const id = req.params.id;
  let removed = false;
  await store.update((data) => {
    const before = data.passkeys.length;
    data.passkeys = data.passkeys.filter(p => p.id !== id);
    removed = data.passkeys.length < before;
  });
  if (!removed) return res.status(404).json({ error: '존재하지 않는 기기' });
  res.json({ ok: true });
});

module.exports = router;
