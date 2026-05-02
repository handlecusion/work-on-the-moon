'use strict';

/**
 * smoke-cmux-client.js — smoke test for lib/cmuxClient.js
 *
 * Runs against the live cmux socket on this Mac. Exits 0 on all PASS,
 * 1 on any FAIL.
 */

const fs = require('fs');
const { createClient, CmuxError, resolveSocketPath } = require('../lib/cmuxClient');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let passed = 0;
let failed = 0;

function pass(name) {
  console.log(`PASS  ${name}`);
  passed++;
}

function fail(name, reason) {
  console.log(`FAIL  ${name}: ${reason}`);
  failed++;
}

function skip(name, reason) {
  console.log(`SKIP  ${name}: ${reason}`);
}

async function run() {
  const client = createClient();

  // 1. resolveSocketPath returns non-null existing path
  const sp = resolveSocketPath();
  if (!sp) {
    fail('1-resolve-socket-path', 'returned null');
  } else {
    try {
      fs.accessSync(sp, fs.constants.F_OK);
      pass(`1-resolve-socket-path (${sp})`);
    } catch {
      fail('1-resolve-socket-path', `path does not exist: ${sp}`);
    }
  }

  // 2. connect()
  try {
    await client.connect();
    if (client.isConnected()) {
      pass('2-connect');
    } else {
      fail('2-connect', 'isConnected() returned false after connect');
    }
  } catch (e) {
    fail('2-connect', String(e));
    console.log('\nCannot continue without a connection. Exiting.');
    process.exit(1);
  }

  // 3. ping()
  try {
    const pong = await client.ping();
    if (pong === true) {
      pass('3-ping');
    } else {
      fail('3-ping', `expected true, got ${pong}`);
    }
  } catch (e) {
    fail('3-ping', String(e));
  }

  // 4. identify() — focused.surface_id uuid
  let focusedSurfaceId = null;
  try {
    const info = await client.identify();
    const sid = info && info.focused && info.focused.surface_id;
    if (sid && UUID_RE.test(sid)) {
      focusedSurfaceId = sid;
      pass(`4-identify (surface_id=${sid})`);
    } else {
      fail('4-identify', `focused.surface_id missing or not uuid: ${JSON.stringify(sid)}`);
    }
  } catch (e) {
    fail('4-identify', String(e));
  }

  // 5. listWindows() — non-empty, first window has uuid id
  let firstWindowId = null;
  try {
    const windows = await client.listWindows();
    if (!Array.isArray(windows) || windows.length === 0) {
      fail('5-list-windows', `expected non-empty array, got ${JSON.stringify(windows)}`);
    } else {
      firstWindowId = windows[0].id;
      if (UUID_RE.test(firstWindowId)) {
        pass(`5-list-windows (${windows.length} windows, first id=${firstWindowId})`);
      } else {
        fail('5-list-windows', `first window id not uuid: ${firstWindowId}`);
      }
    }
  } catch (e) {
    fail('5-list-windows', String(e));
  }

  // 6. listWorkspaces() — non-empty (9 expected), each has currentDirectory + uuid id
  let workspaces = [];
  try {
    workspaces = await client.listWorkspaces();
    if (!Array.isArray(workspaces) || workspaces.length === 0) {
      fail('6-list-workspaces', `expected non-empty array, got ${JSON.stringify(workspaces)}`);
    } else {
      const badEntries = workspaces.filter((ws) => !UUID_RE.test(ws.id) || typeof ws.currentDirectory !== 'string');
      if (badEntries.length > 0) {
        fail('6-list-workspaces', `${badEntries.length} entries missing id/currentDirectory`);
      } else {
        pass(`6-list-workspaces (${workspaces.length} workspaces, all have id + currentDirectory)`);
      }
    }
  } catch (e) {
    fail('6-list-workspaces', String(e));
  }

  // 7. currentWorkspace() — uuid string
  let currentWsId = null;
  try {
    currentWsId = await client.currentWorkspace();
    if (currentWsId && UUID_RE.test(currentWsId)) {
      pass(`7-current-workspace (${currentWsId})`);
    } else {
      fail('7-current-workspace', `expected uuid, got ${JSON.stringify(currentWsId)}`);
    }
  } catch (e) {
    fail('7-current-workspace', String(e));
  }

  // 8. listSurfaces(currentWorkspaceId) — non-empty, at least one focused===true
  let surfaces = [];
  let focusedSurface = null;
  try {
    surfaces = await client.listSurfaces(currentWsId);
    if (!Array.isArray(surfaces) || surfaces.length === 0) {
      fail('8-list-surfaces', `expected non-empty array, got ${JSON.stringify(surfaces)}`);
    } else {
      focusedSurface = surfaces.find((s) => s.focused === true);
      if (focusedSurface) {
        pass(`8-list-surfaces (${surfaces.length} surfaces, focused=${focusedSurface.id})`);
      } else {
        fail('8-list-surfaces', 'no surface has focused===true');
      }
    }
  } catch (e) {
    fail('8-list-surfaces', String(e));
  }

  // 9. readText(focusedSurfaceId) — returns string (may be empty)
  try {
    const text = await client.readText(focusedSurface ? focusedSurface.id : focusedSurfaceId);
    if (typeof text === 'string') {
      pass(`9-read-text (${text.length} chars)`);
    } else {
      fail('9-read-text', `expected string, got ${typeof text}`);
    }
  } catch (e) {
    fail('9-read-text', String(e));
  }

  // 10. sendText safety check
  // Find a safe surface: not the currently focused one in the current workspace,
  // and ideally a shell prompt surface (snapshot ends with $/%/> or title not containing "claude").
  let safeSurface = null;
  let safeWorkspace = null;

  try {
    for (const ws of workspaces) {
      if (!UUID_RE.test(ws.id)) continue;
      const wsSurfaces = await client.listSurfaces(ws.id);
      for (const s of wsSurfaces) {
        // Skip the currently active/focused surface in current workspace
        if (ws.id === currentWsId && s.focused === true) continue;
        // Skip surfaces whose title contains "claude" (case-insensitive)
        if (s.title && /claude/i.test(s.title)) continue;
        // Prefer surfaces where the text snapshot ends with a shell prompt
        try {
          const snap = await client.readText(s.id);
          const trimmed = snap.trimEnd();
          const lastChar = trimmed.slice(-1);
          if (lastChar === '$' || lastChar === '%' || lastChar === '>') {
            safeSurface = s;
            safeWorkspace = ws;
            break;
          }
        } catch { /* can't read — skip */ }
      }
      if (safeSurface) break;
    }
  } catch (e) {
    // Finding a safe surface is best-effort; don't fail the suite
  }

  if (!safeSurface) {
    skip('10-send-text', 'no safe surface found (active session or claude running everywhere)');
  } else {
    try {
      const testComment = '# cmuxClient smoke (no-op)\n';
      await client.sendText(safeSurface.id, testComment);
      // Wait 200ms for terminal to render
      await new Promise((r) => setTimeout(r, 200));
      const snap = await client.readText(safeSurface.id);
      if (snap.includes('# cmuxClient smoke (no-op)')) {
        pass(`10-send-text (surface=${safeSurface.id}, ws=${safeWorkspace.id})`);
      } else {
        fail('10-send-text', 'sent text not visible in snapshot');
      }
    } catch (e) {
      fail('10-send-text', String(e));
    }
  }

  // 11. close()
  try {
    await client.close();
    if (!client.isConnected()) {
      pass('11-close');
    } else {
      fail('11-close', 'isConnected() still true after close');
    }
  } catch (e) {
    fail('11-close', String(e));
  }

  // Summary
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('[smoke] unexpected error:', e);
  process.exit(1);
});
