'use strict';

// ─── Lucide icons ────────────────────────────────────────────────────────────
if (window.lucide) lucide.createIcons();

// ─── DOM refs ────────────────────────────────────────────────────────────────
const recentSection = document.getElementById('recentSection');
const recentList    = document.getElementById('recentList');
const localSection  = document.getElementById('localSection');
const localList     = document.getElementById('localList');
const allSection    = document.getElementById('allSection');
const allList       = document.getElementById('allList');
const logoutBtn     = document.getElementById('logoutBtn');
const toastSlot     = document.getElementById('homeToastSlot');

// ─── Helpers ─────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const t = new Date(iso); if (isNaN(t)) return '';
  const now = new Date();
  const diffSec = Math.floor((now - t) / 1000);
  if (diffSec < 60) return '지금';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm';
  const sameDay = t.toDateString() === now.toDateString();
  if (sameDay) return Math.floor(diffSec / 3600) + 'h';
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (t.toDateString() === yesterday.toDateString()) {
    return '어제 ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
  }
  if (diffSec < 7 * 86400) {
    const wd = ['일','월','화','수','목','금','토'][t.getDay()];
    return wd + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
  }
  return (t.getMonth() + 1) + '/' + t.getDate();
}

function snippetFor(item) {
  const t = item.lastUserText || item.lastAssistantText;
  return t ? t.trim() : '';
}

function dotState(item) {
  if (item.busy) return 'busy';
  if (item.sessionId) return 'idle';
  return 'inactive';
}

function basenameOfCwd(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

// ─── Managed (recent / all) row renderer ─────────────────────────────────────
function renderSessionList(container, items, opts) {
  opts = opts || {};
  const activeName = opts.activeName || null;

  if (!items.length) {
    container.innerHTML = '';
    return;
  }

  const html = [];
  for (const it of items) {
    const snip = snippetFor(it);
    const hasSnip = !!snip;
    const time = formatRelativeTime(it.lastUsedAt);
    const ds = dotState(it);
    const classes = ['session-row'];
    if (hasSnip) classes.push('with-snippet');
    if (it.busy) classes.push('busy');
    if (activeName && it.name === activeName) classes.push('active');

    const agent = it.agent || 'claude';
    const agentIcon = agent === 'codex' ? 'openai' : (agent === 'hermes' ? 'hermes' : 'anthropic');

    html.push(
      '<a class="' + classes.join(' ') + '" ' +
        'href="/chat/' + encodeURIComponent(it.name) + '" ' +
        'data-name="' + escapeHtml(it.name) + '" ' +
        'data-agent="' + escapeHtml(agent) + '" ' +
        'role="option">' +
        '<img class="agent-mark" src="/static/icons/' + agentIcon + '.svg" alt="' + escapeHtml(agent) + '" aria-hidden="true">' +
        '<span class="session-row-dot" data-state="' + ds + '" aria-hidden="true"></span>' +
        '<div class="session-row-main">' +
          '<div class="session-row-title">' + escapeHtml(it.name) + '</div>' +
          (hasSnip
            ? '<div class="session-row-snippet">' + escapeHtml('"' + snip + '"') + '</div>'
            : '') +
        '</div>' +
        (time
          ? '<time class="session-row-time" datetime="' + escapeHtml(it.lastUsedAt || '') + '">' + escapeHtml(time) + '</time>'
          : '') +
      '</a>'
    );
  }

  container.innerHTML = html.join('');
}

// ─── Local (live) row renderer ───────────────────────────────────────────────
function renderLocalList(container, items) {
  if (!items.length) {
    container.innerHTML = '';
    return;
  }
  const html = [];
  for (const it of items) {
    const snip = (it.lastUserText || it.lastAssistantText || '').trim();
    const hasSnip = !!snip;
    const time = formatRelativeTime(it.lastActivityTs);
    const sid = it.sessionId || '';
    const cwd = it.cwd || '';
    const sidShort = sid.slice(0, 8);
    const title = basenameOfCwd(it.cwd) || sidShort || '—';
    let ds = 'inactive';
    if (it.busy) ds = 'busy';
    else if (sid || cwd) ds = 'idle';
    const classes = ['session-row', 'local-row'];
    if (hasSnip) classes.push('with-snippet');
    if (it.busy) classes.push('busy');
    const sourceTxt = it.source || '';
    const pidTxt = it.pid != null ? String(it.pid) : '';
    // Prefer sid-keyed link when sessionId is known; fall back to cwd-keyed
    // route for processes whose sessionId can't be resolved yet (e.g.
    // `--continue` before the first message is written).
    const href = sid
      ? '/chat-live/' + encodeURIComponent(sid)
      : (cwd ? '/chat-live-cwd/' + encodeURIComponent(cwd) : '#');

    const localAgent = it.agent || 'claude';
    const localAgentIcon = localAgent === 'codex' ? 'openai' : (localAgent === 'hermes' ? 'hermes' : 'anthropic');

    html.push(
      '<a class="' + classes.join(' ') + '" ' +
        'href="' + escapeHtml(href) + '" ' +
        'data-sid="' + escapeHtml(sid) + '" ' +
        'data-cwd="' + escapeHtml(cwd) + '" ' +
        'data-agent="' + escapeHtml(localAgent) + '" ' +
        'title="' + escapeHtml(it.cwd || '') + '" ' +
        'role="option">' +
        '<img class="agent-mark" src="/static/icons/' + localAgentIcon + '.svg" alt="' + escapeHtml(localAgent) + '" aria-hidden="true">' +
        '<span class="session-row-dot" data-state="' + ds + '" aria-hidden="true"></span>' +
        '<div class="session-row-main">' +
          '<div class="session-row-title-line">' +
            '<span class="session-row-title">' + escapeHtml(title) + '</span>' +
            (sourceTxt ? '<span class="local-source-badge">' + escapeHtml(sourceTxt) + '</span>' : '') +
            (pidTxt ? '<span class="local-pid-badge">PID ' + escapeHtml(pidTxt) + '</span>' : '') +
          '</div>' +
          (hasSnip
            ? '<div class="session-row-snippet">' + escapeHtml('"' + snip + '"') + '</div>'
            : (sidShort
              ? '<div class="session-row-snippet local-sid-line">' + escapeHtml(sidShort) + '…</div>'
              : '')) +
        '</div>' +
        (time
          ? '<time class="session-row-time" datetime="' + escapeHtml(it.lastActivityTs || '') + '">' + escapeHtml(time) + '</time>'
          : '') +
      '</a>'
    );
  }
  container.innerHTML = html.join('');

  // Defensive: bind explicit click navigation to every rendered local row.
  // Static <a href> sometimes misroutes on iOS Safari when SVG/inner badges
  // intercept the tap. JS handler guarantees navigation lands on /chat-live/.
  container.querySelectorAll('a.session-row.local-row').forEach((a) => {
    a.addEventListener('click', (e) => {
      const sid = a.getAttribute('data-sid');
      const cwd = a.getAttribute('data-cwd');
      if (!sid && !cwd) return; // truly inactive entry, let default `#` happen
      e.preventDefault();
      location.href = sid
        ? '/chat-live/' + encodeURIComponent(sid)
        : '/chat-live-cwd/' + encodeURIComponent(cwd);
    });
  });
}

window.__renderSessionList = renderSessionList;

// ─── Agent picker sheet ───────────────────────────────────────────────────────
(function () {
  const backdrop  = document.getElementById('agentPickerBackdrop');
  const sheet     = document.getElementById('agentPickerSheet');
  const titleEl   = document.getElementById('agentPickerTitle');
  const claudeEl  = document.getElementById('agentPickerClaude');
  const codexEl   = document.getElementById('agentPickerCodex');
  const hermesEl  = document.getElementById('agentPickerHermes');
  const claudeMeta = document.getElementById('agentPickerClaudeMeta');
  const codexMeta  = document.getElementById('agentPickerCodexMeta');
  const hermesMeta = document.getElementById('agentPickerHermesMeta');
  const closeBtn  = document.getElementById('agentPickerClose');

  function metaText(agentData) {
    if (!agentData || (!agentData.lastUsedAt && !agentData.messageCount)) {
      return '처음 시작';
    }
    const parts = [];
    if (agentData.lastUsedAt) parts.push(formatRelativeTime(agentData.lastUsedAt));
    if (agentData.messageCount != null && agentData.messageCount > 0) {
      parts.push(agentData.messageCount + ' messages');
    }
    return parts.join(' · ');
  }

  function openSheet() {
    backdrop.style.display = 'block';
    sheet.hidden = false;
    document.body.classList.add('agent-picker-open');
    // rAF so display:block is committed before transition starts
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        backdrop.classList.add('visible');
        sheet.classList.add('visible');
      });
    });
    const closeEl = sheet.querySelector('.agent-picker-close');
    if (closeEl) closeEl.focus();
  }

  function closeSheet() {
    backdrop.classList.remove('visible');
    sheet.classList.remove('visible');
    document.body.classList.remove('agent-picker-open');
    const onEnd = () => {
      backdrop.style.display = 'none';
      sheet.hidden = true;
      sheet.removeEventListener('transitionend', onEnd);
    };
    sheet.addEventListener('transitionend', onEnd);
  }

  window.openAgentPicker = function openAgentPicker(projectName, agentMeta) {
    agentMeta = agentMeta || {};
    titleEl.textContent = projectName;

    const base = '/chat/' + encodeURIComponent(projectName);
    claudeEl.href = base + '?agent=claude';
    codexEl.href  = base + '?agent=codex';
    if (hermesEl) hermesEl.href = base + '?agent=hermes';

    claudeMeta.textContent = metaText(agentMeta.claude);
    codexMeta.textContent  = metaText(agentMeta.codex);
    if (hermesMeta) hermesMeta.textContent = metaText(agentMeta.hermes);

    openSheet();
  };

  closeBtn.addEventListener('click', closeSheet);
  backdrop.addEventListener('click', closeSheet);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheet.hidden) closeSheet();
  });
}());

// iOS Safari aggressively serves pages from the back-forward cache, which
// restores DOM with stale click handlers and bypasses Cache-Control. Force a
// full reload when the page is restored from BFCache.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});

// ─── Toast ───────────────────────────────────────────────────────────────────
function showHomeToast(message, onRetry) {
  toastSlot.innerHTML =
    '<div class="home-toast" role="alert">' +
      '<span>' + escapeHtml(message) + '</span>' +
      '<button id="homeToastRetry">다시 시도</button>' +
    '</div>';
  document.getElementById('homeToastRetry').addEventListener('click', () => {
    toastSlot.innerHTML = '';
    if (typeof onRetry === 'function') onRetry();
  });
}

// ─── Categorisation ──────────────────────────────────────────────────────────
function categorize(payload) {
  // payload may be either the legacy array (older server) or {managed, localActive}.
  let managed = [];
  let localActive = [];
  if (Array.isArray(payload)) {
    managed = payload;
  } else if (payload && typeof payload === 'object') {
    managed = Array.isArray(payload.managed) ? payload.managed : [];
    localActive = Array.isArray(payload.localActive) ? payload.localActive : [];
  }
  const recent = managed.filter((i) => i.hasMessages === true);
  const all = managed
    .filter((i) => i.hasMessages === false)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  // Local: busy first, then by lastActivityTs desc
  const local = localActive.slice().sort((a, b) => {
    if (a.busy !== b.busy) return a.busy ? -1 : 1;
    const ta = a.lastActivityTs ? Date.parse(a.lastActivityTs) : -Infinity;
    const tb = b.lastActivityTs ? Date.parse(b.lastActivityTs) : -Infinity;
    return tb - ta;
  });

  return { recent, local, all };
}

// ─── Polling + render ────────────────────────────────────────────────────────
let pollTimer = null;
let lastPayloadJson = null;
let inFlight = false;

async function load(opts) {
  opts = opts || {};
  const { silent } = opts;
  if (inFlight) return;
  inFlight = true;
  if (!silent) {
    // Initial paint clears placeholders
    if (lastPayloadJson === null) {
      recentList.innerHTML = '';
      localList.innerHTML = '';
      allList.innerHTML = '';
      toastSlot.innerHTML = '';
    }
  }
  try {
    const r = await fetch('/api/sessions?include=local', { credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/login'; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const payload = await r.json();

    // Skip render if nothing changed
    const json = JSON.stringify(payload);
    if (json === lastPayloadJson) return;
    lastPayloadJson = json;

    const { recent, local, all } = categorize(payload);

    // Recent
    if (recent.length === 0) {
      recentList.innerHTML = '<div class="session-section-empty">최근 대화 없음</div>';
    } else {
      renderSessionList(recentList, recent, { mode: 'home' });
    }

    // Local
    if (local.length === 0) {
      localSection.style.display = 'none';
    } else {
      localSection.style.display = '';
      renderLocalList(localList, local);
    }

    // All projects — build per-name agentMeta map then wire picker
    if (all.length === 0) {
      allSection.style.display = 'none';
    } else {
      allSection.style.display = '';
      // Aggregate both claude + codex entries per project name
      const agentMetaByName = {};
      for (const it of all) {
        const n = it.name;
        if (!agentMetaByName[n]) agentMetaByName[n] = {};
        const agentKey = (it.agent || 'claude').toLowerCase();
        agentMetaByName[n][agentKey] = {
          lastUsedAt:   it.lastUsedAt   || null,
          messageCount: it.messageCount || 0,
        };
      }
      // Deduplicate by name for rendering (show one row per project)
      const seen = new Set();
      const dedupedAll = all.filter((it) => {
        if (seen.has(it.name)) return false;
        seen.add(it.name);
        return true;
      });
      renderSessionList(allList, dedupedAll, { mode: 'home' });

      // Intercept clicks → open picker instead of navigating
      allList.querySelectorAll('a.session-row').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const name = a.getAttribute('data-name') || a.dataset.name || '';
          if (!name) return;
          window.openAgentPicker(name, agentMetaByName[name] || {});
        });
      });
    }

    if (window.lucide) lucide.createIcons();
    // Clear any prior error toast if we recovered
    if (toastSlot.firstChild) toastSlot.innerHTML = '';
  } catch (e) {
    if (!silent) showHomeToast('세션 목록을 불러오지 못했습니다.', () => load());
  } finally {
    inFlight = false;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    load({ silent: true });
  }, 10000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // Refresh immediately when becoming visible again.
  load({ silent: true });
});

logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (_) {}
  location.href = '/login';
});

// Boot
load();
startPolling();
