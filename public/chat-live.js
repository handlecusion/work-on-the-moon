'use strict';

// ─── chat-live.js — read-only live attach (PR-E2) ────────────────────────────
//
// Most of the rendering core (renderEvent / renderUserBubble /
// renderAssistantBubble / renderToolUseCard / updateToolResultBody / renderCard)
// is copy/pasted from public/chat.js so we can ship PR-E2 without a risky
// shared-module refactor. A future PR should consolidate into a shared
// public/messageRenderer.js — see TODO markers below.
//
// Stripped from chat.js: input/textarea handling, slash picker, account swap
// modal/flow, quota retry button, session switcher, newChat. None of those
// are wired to DOM elements that exist on chat-live.html, so calling them
// would crash.
//
// Initialise Lucide icons (first pass, before dynamic content)
lucide.createIcons();

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  pinned: true,
  hasMessages: false,
  reconnectAttempted: false,
  ws: null,
  connected: false,
  meta: null,
  sessionId: null,
  cmux: { available: false, surfaceId: null, workspaceId: null },
  tmux: { available: false, socketPath: null, paneId: null }
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const chatMessages    = $('chatMessages');
const projectLabel    = $('projectNameLabel');
const liveSourcePill  = $('liveSourcePill');
const liveCwd         = $('liveCwd');
const livePid         = $('livePid');
const liveStartedAt   = $('liveStartedAt');
const liveStatus      = $('liveStatus');
const busyIndicator   = $('busyIndicator');
const scrollBtn       = $('scrollBtn');
const chatToast       = $('chatToast');
const chatToastText   = $('chatToastText');
const disconnectBanner = $('disconnectBanner');
const refreshBtn      = $('refreshBtn');
const connDot         = $('connDot');
const liveTextarea    = $('liveTextarea');
const liveSendBtn     = $('liveSendBtn');
const liveCmuxStatus  = $('liveCmuxStatus');

// ─── Session ID / cwd from URL ────────────────────────────────────────────────
// Two URL shapes:
//   /chat-live/<sessionId>     — UUID-keyed (preferred, transcript known)
//   /chat-live-cwd/<cwd>       — cwd-keyed (sessionId unknown until claude
//                                writes the first message; e.g. `--continue`
//                                with no UUID)
state.sessionId = null;
state.cwd = null;
{
  const path = location.pathname;
  if (path.indexOf('/chat-live-cwd/') === 0) {
    state.cwd = decodeURIComponent(path.slice('/chat-live-cwd/'.length));
  } else {
    state.sessionId = decodeURIComponent(path.split('/').filter(Boolean).pop() || '');
  }
}
{
  const head = state.sessionId
    ? state.sessionId.slice(0, 8)
    : (state.cwd ? state.cwd.split('/').filter(Boolean).pop() : '');
  document.title = (head || 'live') + ' — Working in the Moon';
}

// Defensive: force home navigation on back-button click. Some iOS Safari
// versions misroute anchor clicks when the click target is a child SVG that
// lucide injected; explicit handler bypasses that.
const backBtn = document.getElementById('backBtn');
if (backBtn) {
  backBtn.addEventListener('click', (e) => {
    e.preventDefault();
    location.href = '/';
  });
}

// ─── Helpers (copy from chat.js) ─────────────────────────────────────────────
// TODO consolidate with chat.js renderer (extract to /static/messageRenderer.js)
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderIcons() { lucide.createIcons(); }

(function setupMarkdown() {
  if (typeof DOMPurify === 'undefined') return;
  DOMPurify.addHook('afterSanitizeAttributes', function (node) {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
})();

function guessLang(filename) {
  if (!filename) return null;
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map = {
    ts:'typescript', tsx:'typescript', js:'javascript', jsx:'javascript',
    py:'python', sh:'bash', bash:'bash', zsh:'bash', json:'json',
    md:'markdown', markdown:'markdown', css:'css', html:'html', htm:'html',
    yml:'yaml', yaml:'yaml', go:'go', rs:'rust', java:'java', sql:'sql',
    rb:'ruby', php:'php', c:'c', h:'c', cpp:'cpp', cc:'cpp', cxx:'cpp',
    swift:'swift', kt:'kotlin', xml:'xml', toml:'toml', ini:'ini', cfg:'ini',
    dockerfile:'dockerfile'
  };
  return map[ext] || null;
}

function stripAnsi(s) {
  return String(s == null ? '' : s).replace(/\x1B\[[0-9;]*m/g, '');
}

function highlightCode(code, filename) {
  if (typeof hljs === 'undefined') return escapeHtml(code);
  try {
    const lang = guessLang(filename);
    if (lang) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    return hljs.highlightAuto(code).value;
  } catch (_) { return escapeHtml(code); }
}

function buildDiffHtml(oldStr, newStr, filename) {
  if (typeof Diff === 'undefined') {
    return '<pre class="diff-fallback">' + escapeHtml(newStr) + '</pre>';
  }
  try {
    const patch = Diff.createPatch(filename || 'file', oldStr || '', newStr || '', '', '');
    const lines = patch.split('\n').slice(4);
    const html = lines.map(function (l) {
      if (l.startsWith('+') && !l.startsWith('+++')) return '<div class="diff-add">' + escapeHtml(l) + '</div>';
      if (l.startsWith('-') && !l.startsWith('---')) return '<div class="diff-del">' + escapeHtml(l) + '</div>';
      if (l.startsWith('@@')) return '<div class="diff-hunk">' + escapeHtml(l) + '</div>';
      return '<div class="diff-ctx">' + escapeHtml(l) + '</div>';
    }).join('');
    return '<div class="diff-view">' + html + '</div>';
  } catch (_) {
    return '<pre>' + escapeHtml(newStr) + '</pre>';
  }
}

function extractResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(function (block) {
      if (!block) return '';
      if (block.type === 'text') return block.text || '';
      if (block.type === 'image') return '[image]';
      return '';
    }).join('\n');
  }
  return JSON.stringify(content);
}

const toolUseElements = new Map();

function basename(filepath) {
  if (!filepath) return '';
  return filepath.split('/').pop() || filepath;
}

function addCopyButton(preEl, getText) {
  const btn = document.createElement('button');
  btn.className = 'code-copy-btn';
  btn.setAttribute('aria-label', '복사');
  btn.innerHTML = '<i data-lucide="copy"></i>';
  btn.addEventListener('click', function () {
    const text = getText();
    navigator.clipboard.writeText(text).then(function () {
      btn.innerHTML = '<i data-lucide="check"></i>';
      renderIcons();
      setTimeout(function () {
        btn.innerHTML = '<i data-lucide="copy"></i>';
        renderIcons();
      }, 2000);
    }).catch(function () { showToast('클립보드 복사 실패', 'error'); });
  });
  preEl.style.position = 'relative';
  preEl.appendChild(btn);
  return btn;
}

function setConnState(s) {
  if (connDot) connDot.dataset.state = s;
  state.connected = s === 'connected';
}

let toastTimer = null;
function showToast(msg, kind) {
  chatToastText.textContent = msg;
  chatToast.classList.remove('info');
  if (kind === 'info') chatToast.classList.add('info');
  chatToast.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { chatToast.classList.remove('visible'); }, 5000);
}

// ─── Scroll pinning ──────────────────────────────────────────────────────────
function isNearBottom() {
  const threshold = 100;
  return chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < threshold;
}

function scrollToBottom(force) {
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (force) {
    state.pinned = true;
    if (scrollBtn) scrollBtn.classList.remove('visible');
  }
}

chatMessages.addEventListener('scroll', () => {
  const near = isNearBottom();
  if (near) {
    state.pinned = true;
    if (scrollBtn) scrollBtn.classList.remove('visible');
  } else {
    state.pinned = false;
    if (scrollBtn) scrollBtn.classList.add('visible');
  }
}, { passive: true });

if (scrollBtn) {
  scrollBtn.addEventListener('click', () => { scrollToBottom(true); });
}

// ─── Message rendering ───────────────────────────────────────────────────────
function getMessagesInner() {
  return chatMessages.querySelector('.chat-messages-inner');
}

function removeEmptyState() {
  const es = chatMessages.querySelector('.chat-empty');
  if (es && es.parentNode) es.remove();
  state.hasMessages = true;
}

// When set, renderEvent sends new nodes into this DocumentFragment-like
// container instead of the live messages list. Used by chunked head loading.
let appendTargetOverride = null;

function appendNode(node) {
  if (appendTargetOverride) {
    appendTargetOverride.appendChild(node);
    return;
  }
  removeEmptyState();
  getMessagesInner().appendChild(node);
  if (state.pinned) scrollToBottom(false);
  renderIcons();
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function renderUserBubble(text) {
  const row = el('div', 'msg-row user');
  const bubble = el('div', 'msg-bubble', escapeHtml(text));
  row.appendChild(bubble);
  appendNode(row);
}

function renderAssistantBubble(text) {
  const row = el('div', 'msg-row assistant');
  const bubble = el('div', 'msg-bubble md-content');
  bubble.style.whiteSpace = 'normal';
  try {
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      const rawHtml = marked.parse(text, { breaks: true, gfm: true });
      const clean = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
      bubble.innerHTML = clean;
      requestAnimationFrame(function () {
        const codeBlocks = bubble.querySelectorAll('pre code');
        codeBlocks.forEach(function (codeEl) {
          if (typeof hljs !== 'undefined') {
            try { hljs.highlightElement(codeEl); } catch (_) {}
          }
          const preEl = codeEl.parentElement;
          if (preEl && preEl.tagName === 'PRE') {
            addCopyButton(preEl, function () { return codeEl.textContent || ''; });
          }
        });
        renderIcons();
      });
    } else {
      bubble.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
    }
  } catch (_) {
    bubble.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
  }
  row.appendChild(bubble);
  appendNode(row);
}

function renderSystemNote(html) {
  const row = el('div', 'msg-row system-note');
  const note = el('div', 'msg-system', html);
  row.appendChild(note);
  appendNode(row);
}

function renderCard(iconName, label, bodyHtml, isError) {
  const card = el('div', 'msg-card');
  const headerClass = 'msg-card-header' + (isError ? ' error-card' : '');
  let labelHtml;
  const colonIdx = label.indexOf(': ');
  if (colonIdx !== -1) {
    const prefix = label.slice(0, colonIdx);
    const toolName = label.slice(colonIdx + 2);
    labelHtml =
      '<span class="card-label-text">' + escapeHtml(prefix) + '</span>' +
      '<span class="card-tool-pill">' + escapeHtml(toolName) + '</span>';
  } else {
    labelHtml = '<span class="card-label-text">' + escapeHtml(label) + '</span>';
  }
  card.innerHTML =
    '<div class="' + headerClass + '" tabindex="0" role="button" aria-expanded="false">' +
      '<i data-lucide="' + escapeHtml(iconName) + '"></i>' +
      labelHtml +
      '<span class="card-spacer"></span>' +
      '<span class="card-toggle"><i data-lucide="chevron-down"></i></span>' +
    '</div>' +
    '<div class="msg-card-body">' + bodyHtml + '</div>';

  const header = card.querySelector('.msg-card-header');
  function toggleCard() {
    card.classList.toggle('expanded');
    const expanded = card.classList.contains('expanded');
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const toggle = card.querySelector('.card-toggle');
    toggle.innerHTML = expanded
      ? '<i data-lucide="chevron-up"></i>'
      : '<i data-lucide="chevron-down"></i>';
    renderIcons();
  }
  header.addEventListener('click', toggleCard);
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCard(); }
  });

  const row = el('div', 'msg-row assistant');
  row.appendChild(card);
  appendNode(row);
}

function buildToolCard(iconName, labelText, pillText, statusHtml, bodyHtml, isError) {
  const card = el('div', 'msg-card tool-card' + (isError ? ' tool-card-error' : ''));
  const headerClass = 'msg-card-header tool-card-header' + (isError ? ' error-card' : '');
  const pillHtml = pillText
    ? '<span class="card-tool-pill">' + escapeHtml(pillText) + '</span>'
    : '';
  card.innerHTML =
    '<div class="' + headerClass + '" tabindex="0" role="button" aria-expanded="false">' +
      '<i data-lucide="' + escapeHtml(iconName) + '"></i>' +
      '<span class="card-label-text">' + escapeHtml(labelText) + '</span>' +
      pillHtml +
      '<span class="card-spacer"></span>' +
      (statusHtml || '') +
      '<span class="card-toggle"><i data-lucide="chevron-down"></i></span>' +
    '</div>' +
    '<div class="msg-card-body tool-card-body">' + bodyHtml + '</div>';

  const header = card.querySelector('.msg-card-header');
  function toggleCard() {
    card.classList.toggle('expanded');
    const expanded = card.classList.contains('expanded');
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const toggle = card.querySelector('.card-toggle');
    toggle.innerHTML = expanded
      ? '<i data-lucide="chevron-up"></i>'
      : '<i data-lucide="chevron-down"></i>';
    renderIcons();
  }
  header.addEventListener('click', toggleCard);
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCard(); }
  });
  return card;
}

function waitingBodyHtml() {
  return '<div class="tool-waiting"><span class="spin"><i data-lucide="loader-2"></i></span><span class="tool-waiting-label">결과 대기 중…</span></div>';
}

function bodyForRead(input) {
  const file = input.file_path || '';
  const startLine = input.start_line || input.offset || null;
  const endLine = input.end_line || null;
  let rangeNote = '';
  if (startLine != null) rangeNote = ' (lines ' + startLine + (endLine ? '–' + endLine : '+') + ')';
  return '<div class="tool-body-read"><span class="tool-file-label">' + escapeHtml(file) + '</span>' + escapeHtml(rangeNote) + '</div>' + waitingBodyHtml();
}
function bodyForBash(input) {
  const cmd = (input.command || '').slice(0, 200);
  return '<div class="tool-body-bash"><pre class="tool-cmd-pre"><code>' + escapeHtml(cmd) + '</code></pre></div>' + waitingBodyHtml();
}
function bodyForEdit(input) {
  const file = input.file_path || '';
  return '<div class="tool-body-edit" data-file="' + escapeHtml(file) + '">' + waitingBodyHtml() + '</div>';
}
function bodyForWrite(input) {
  const file = input.file_path || '';
  const content = input.content || '';
  const highlighted = highlightCode(content.slice(0, 8000), file);
  const pre = document.createElement('pre');
  pre.className = 'tool-body-write-pre hljs';
  pre.innerHTML = '<code>' + highlighted + '</code>';
  const wrapper = document.createElement('div');
  wrapper.className = 'tool-body-write';
  wrapper.appendChild(pre);
  addCopyButton(pre, function () { return content; });
  return wrapper;
}
function bodyForGlob() { return '<div class="tool-body-glob">' + waitingBodyHtml() + '</div>'; }
function bodyForGrep() { return '<div class="tool-body-grep">' + waitingBodyHtml() + '</div>'; }
function bodyForTodoWrite(input) {
  const todos = input.todos || [];
  if (!todos.length) return waitingBodyHtml();
  let listHtml = '<ul class="todo-list">';
  todos.forEach(function (t) {
    const statusClass = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'in_progress' : 'pending';
    let iconName = 'circle';
    if (t.status === 'completed') iconName = 'check-circle-2';
    else if (t.status === 'in_progress') iconName = 'loader-2';
    listHtml +=
      '<li class="todo-item ' + statusClass + '">' +
        '<i data-lucide="' + iconName + '" class="todo-status-icon"></i>' +
        '<span class="todo-content">' + escapeHtml(t.content || '') + '</span>' +
      '</li>';
  });
  listHtml += '</ul>';
  return '<div class="tool-body-todo">' + listHtml + '</div>';
}
function bodyForTask(input) {
  const agentType = input.subagent_type || input.agent || '—';
  const desc = input.description || input.prompt || '';
  return '<div class="tool-body-task"><div class="tool-task-agent">' + escapeHtml(agentType) + '</div>' +
    (desc ? '<div class="tool-task-desc">' + escapeHtml(desc.slice(0, 300)) + (desc.length > 300 ? '…' : '') + '</div>' : '') +
    waitingBodyHtml() + '</div>';
}
function bodyForWebFetch(input) {
  const url = input.url || '';
  return '<div class="tool-body-webfetch"><a class="tool-url-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(url.slice(0, 80)) + '</a>' + waitingBodyHtml() + '</div>';
}
function bodyForWebSearch(input) {
  const query = input.query || '';
  return '<div class="tool-body-websearch"><span class="tool-search-query">' + escapeHtml(query) + '</span>' + waitingBodyHtml() + '</div>';
}

function renderToolUseCard(evt) {
  const name = evt.name || 'unknown';
  const input = evt.input || {};
  const toolUseId = evt.toolUseId || null;
  let iconName = 'wrench';
  let labelText = name;
  let pillText = null;
  let bodyNodeOrHtml = waitingBodyHtml();
  let bodyClass = 'tool-body-generic';

  switch (name) {
    case 'Read': {
      iconName = 'file-text'; labelText = 'Read';
      const fp = input.file_path || ''; pillText = basename(fp);
      const startLine = input.start_line || input.offset || null;
      const endLine = input.end_line || null;
      if (startLine != null) pillText += ':' + startLine + (endLine ? '–' + endLine : '+');
      bodyNodeOrHtml = bodyForRead(input); bodyClass = 'tool-body-read-wrap';
      break;
    }
    case 'Bash': {
      iconName = 'terminal'; labelText = 'Bash';
      const cmd = (input.command || '').trim();
      pillText = cmd.slice(0, 60) + (cmd.length > 60 ? '…' : '');
      bodyNodeOrHtml = bodyForBash(input); bodyClass = 'tool-body-bash';
      break;
    }
    case 'Edit': {
      iconName = 'pencil'; labelText = 'Edit';
      pillText = basename(input.file_path || '');
      bodyNodeOrHtml = bodyForEdit(input); bodyClass = 'tool-body-edit';
      break;
    }
    case 'Write': {
      iconName = 'file-plus'; labelText = 'Write';
      pillText = basename(input.file_path || '');
      bodyNodeOrHtml = bodyForWrite(input); bodyClass = 'tool-body-write';
      break;
    }
    case 'Glob': {
      iconName = 'search'; labelText = 'Glob';
      pillText = input.pattern || input.glob || '';
      bodyNodeOrHtml = bodyForGlob(input); bodyClass = 'tool-body-glob';
      break;
    }
    case 'Grep': {
      iconName = 'search'; labelText = 'Grep';
      pillText = input.pattern || input.query || input.regex || '';
      bodyNodeOrHtml = bodyForGrep(input); bodyClass = 'tool-body-grep';
      break;
    }
    case 'TodoWrite': {
      iconName = 'list-checks'; labelText = 'Todos';
      const todos = input.todos || [];
      const doneCnt = todos.filter(function (t) { return t.status === 'completed'; }).length;
      pillText = doneCnt + '/' + todos.length;
      bodyNodeOrHtml = bodyForTodoWrite(input); bodyClass = 'tool-body-todo-wrap';
      break;
    }
    case 'Task': {
      iconName = 'bot'; labelText = 'Task';
      pillText = input.subagent_type || input.agent || '';
      bodyNodeOrHtml = bodyForTask(input); bodyClass = 'tool-body-task-wrap';
      break;
    }
    case 'WebFetch': {
      iconName = 'link'; labelText = 'WebFetch';
      const fetchUrl = input.url || '';
      pillText = fetchUrl.replace(/^https?:\/\//, '').slice(0, 40);
      bodyNodeOrHtml = bodyForWebFetch(input); bodyClass = 'tool-body-webfetch';
      break;
    }
    case 'WebSearch': {
      iconName = 'globe'; labelText = 'WebSearch';
      pillText = (input.query || '').slice(0, 40);
      bodyNodeOrHtml = bodyForWebSearch(input); bodyClass = 'tool-body-websearch';
      break;
    }
    default: {
      iconName = 'wrench'; labelText = name; pillText = null;
      bodyNodeOrHtml = '<pre class="tool-json-pre">' + escapeHtml(JSON.stringify(input, null, 2)) + '</pre>';
      bodyClass = 'tool-body-generic';
      break;
    }
  }

  const statusHtml = '<span class="tool-status spin"><i data-lucide="loader-2"></i></span>';
  const card = buildToolCard(iconName, labelText, pillText, statusHtml, '', false);
  const bodyEl = card.querySelector('.msg-card-body');
  bodyEl.className = 'msg-card-body tool-card-body ' + bodyClass;
  if (typeof bodyNodeOrHtml === 'string') bodyEl.innerHTML = bodyNodeOrHtml;
  else { bodyEl.innerHTML = ''; bodyEl.appendChild(bodyNodeOrHtml); }

  if (toolUseId) toolUseElements.set(toolUseId, { card, bodyEl, name, input });

  const row = el('div', 'msg-row assistant');
  row.appendChild(card);
  appendNode(row);
}

function updateToolResultBody(evt) {
  const toolUseId = evt.toolUseId || null;
  const isError = evt.isError === true;
  const content = evt.content;
  const resultText = extractResultText(content);

  function setStatus(card, isErr) {
    const existing = card.querySelector('.tool-status');
    if (existing) {
      if (isErr) {
        existing.className = 'tool-status tool-status-error';
        existing.innerHTML = '<i data-lucide="alert-circle"></i>';
      } else {
        existing.className = 'tool-status tool-status-done';
        existing.innerHTML = '<i data-lucide="check"></i>';
      }
    }
    if (isErr) {
      card.classList.add('tool-card-error');
      const header = card.querySelector('.msg-card-header');
      if (header) header.classList.add('error-card');
    }
  }

  if (!toolUseId || !toolUseElements.has(toolUseId)) {
    const label = 'Result' + (toolUseId ? ': ' + toolUseId.slice(0, 8) : '');
    let body;
    if (typeof content === 'string') {
      body = '<pre>' + escapeHtml(content) + '</pre>';
    } else {
      body = '<pre>' + escapeHtml(JSON.stringify(content, null, 2)) + '</pre>';
    }
    renderCard(isError ? 'alert-circle' : 'check-circle', label, body, isError);
    return;
  }

  const { card, bodyEl, name, input } = toolUseElements.get(toolUseId);
  setStatus(card, isError);

  if (isError) {
    card.classList.add('expanded');
    const header = card.querySelector('.msg-card-header');
    if (header) {
      header.setAttribute('aria-expanded', 'true');
      const toggle = header.querySelector('.card-toggle');
      if (toggle) toggle.innerHTML = '<i data-lucide="chevron-up"></i>';
    }
  }

  let newBodyHtml = '';
  switch (name) {
    case 'Read': {
      const clean = stripAnsi(resultText);
      const lines = clean.split('\n').slice(0, 50);
      const truncated = lines.join('\n');
      const hasMore = clean.split('\n').length > 50;
      const highlighted = highlightCode(truncated, input.file_path || '');
      newBodyHtml =
        '<pre class="tool-read-pre hljs"><code>' + highlighted + '</code></pre>' +
        (hasMore ? '<div class="tool-more-hint">+ 더 많은 내용…</div>' : '');
      bodyEl.innerHTML = newBodyHtml;
      bodyEl.querySelectorAll('pre').forEach(function (pre) {
        addCopyButton(pre, function () { return clean; });
      });
      break;
    }
    case 'Bash': {
      const clean = stripAnsi(resultText);
      const isErr = isError;
      const preClass = isErr ? 'tool-bash-pre tool-bash-stderr' : 'tool-bash-pre';
      const lines = clean.split('\n');
      const shown = lines.slice(0, 200).join('\n');
      const hasMore = lines.length > 200;
      newBodyHtml =
        '<div class="tool-body-bash">' +
          '<pre class="' + preClass + '"><code>' + escapeHtml(shown) + '</code></pre>' +
          (hasMore ? '<button class="tool-show-all-btn">전체 보기 (' + lines.length + '줄)</button>' : '') +
        '</div>';
      bodyEl.innerHTML = newBodyHtml;
      const pre = bodyEl.querySelector('pre');
      if (pre) addCopyButton(pre, function () { return clean; });
      const showAllBtn = bodyEl.querySelector('.tool-show-all-btn');
      if (showAllBtn) {
        showAllBtn.addEventListener('click', function () {
          const fullPre = bodyEl.querySelector('pre code');
          if (fullPre) fullPre.textContent = clean;
          showAllBtn.remove();
        });
      }
      break;
    }
    case 'Edit': {
      const file = input.file_path || '';
      const diffHtml = buildDiffHtml(input.old_string || '', input.new_string || '', file);
      newBodyHtml = '<div class="tool-body-edit">' + diffHtml + '</div>';
      bodyEl.innerHTML = newBodyHtml;
      break;
    }
    case 'Write': {
      if (isError) bodyEl.innerHTML += '<div class="tool-error-note">' + escapeHtml(resultText.slice(0, 200)) + '</div>';
      break;
    }
    case 'Glob': {
      const lines = resultText.split('\n').filter(function (l) { return l.trim(); });
      const shown = lines.slice(0, 50);
      const hasMore = lines.length > 50;
      let listHtml = '<ul class="tool-glob-list">';
      shown.forEach(function (f) { listHtml += '<li class="tool-glob-item">' + escapeHtml(f) + '</li>'; });
      listHtml += '</ul>';
      if (hasMore) listHtml += '<div class="tool-more-hint">+ ' + (lines.length - 50) + ' more</div>';
      bodyEl.innerHTML = '<div class="tool-body-glob">' + listHtml + '</div>';
      break;
    }
    case 'Grep': {
      const lines = resultText.split('\n').filter(function (l) { return l.trim(); });
      let listHtml = '<div class="tool-grep-list">';
      lines.forEach(function (line) {
        const firstColon = line.indexOf(':');
        const secondColon = firstColon >= 0 ? line.indexOf(':', firstColon + 1) : -1;
        let pathPart = '', contentPart = '';
        if (secondColon > firstColon && firstColon >= 0) {
          pathPart = line.slice(0, secondColon);
          contentPart = line.slice(secondColon + 1);
        } else { contentPart = line; }
        listHtml +=
          '<div class="grep-hit" role="button" tabindex="0" title="클릭하여 경로 복사">' +
            (pathPart ? '<span class="grep-path">' + escapeHtml(pathPart) + '</span> ' : '') +
            '<span class="grep-content">' + escapeHtml(contentPart.slice(0, 120)) + '</span>' +
          '</div>';
      });
      listHtml += '</div>';
      bodyEl.innerHTML = '<div class="tool-body-grep">' + listHtml + '</div>';
      bodyEl.querySelectorAll('.grep-hit').forEach(function (hitEl) {
        const pathEl = hitEl.querySelector('.grep-path');
        const toCopy = pathEl ? pathEl.textContent : hitEl.textContent;
        hitEl.addEventListener('click', function () {
          navigator.clipboard.writeText(toCopy).then(function () {
            const orig = hitEl.style.background;
            hitEl.style.background = 'var(--accent-soft)';
            setTimeout(function () { hitEl.style.background = orig; }, 800);
          }).catch(function () {});
        });
        hitEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hitEl.click(); }
        });
      });
      break;
    }
    case 'TodoWrite': {
      if (isError) bodyEl.innerHTML += '<div class="tool-error-note">' + escapeHtml(resultText.slice(0, 200)) + '</div>';
      break;
    }
    case 'Task': {
      const resultSnip = resultText.slice(0, 500);
      newBodyHtml =
        '<div class="tool-body-task">' +
          '<div class="tool-task-agent">' + escapeHtml(input.subagent_type || '') + '</div>' +
          '<div class="tool-task-result">' + escapeHtml(resultSnip) + (resultText.length > 500 ? '…' : '') + '</div>' +
        '</div>';
      bodyEl.innerHTML = newBodyHtml;
      break;
    }
    case 'WebFetch': {
      const excerpt = resultText.slice(0, 400);
      newBodyHtml =
        '<div class="tool-body-webfetch">' +
          '<a class="tool-url-link" href="' + escapeHtml(input.url || '') + '" target="_blank" rel="noopener noreferrer">' + escapeHtml((input.url || '').slice(0, 80)) + '</a>' +
          '<pre class="tool-fetch-pre">' + escapeHtml(excerpt) + (resultText.length > 400 ? '…' : '') + '</pre>' +
        '</div>';
      bodyEl.innerHTML = newBodyHtml;
      break;
    }
    case 'WebSearch': {
      let resultsHtml = '';
      try {
        const parsed = JSON.parse(resultText);
        const items = Array.isArray(parsed) ? parsed : (parsed.results || parsed.organic || []);
        const shown = items.slice(0, 10);
        shown.forEach(function (item) {
          const title = item.title || item.name || '';
          const url = item.url || item.link || item.href || '';
          const snippet = item.snippet || item.description || '';
          resultsHtml +=
            '<div class="tool-search-result">' +
              (url ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer" class="tool-search-title">' + escapeHtml(title || url) + '</a>' : '<div class="tool-search-title">' + escapeHtml(title) + '</div>') +
              (url ? '<div class="tool-search-url">' + escapeHtml(url.slice(0, 80)) + '</div>' : '') +
              (snippet ? '<div class="tool-search-snippet">' + escapeHtml(snippet.slice(0, 150)) + '</div>' : '') +
            '</div>';
        });
      } catch (_) {
        resultsHtml = '<pre class="tool-fetch-pre">' + escapeHtml(resultText.slice(0, 600)) + '</pre>';
      }
      bodyEl.innerHTML = '<div class="tool-body-websearch">' + resultsHtml + '</div>';
      break;
    }
    default: {
      newBodyHtml = '<pre class="tool-json-pre">' + escapeHtml(resultText.slice(0, 2000)) + '</pre>';
      bodyEl.innerHTML = newBodyHtml;
      break;
    }
  }

  toolUseElements.delete(toolUseId);
  renderIcons();
}

// ─── Event renderer (live-flavored) ──────────────────────────────────────────
function renderEvent(evt) {
  const kind = evt && evt.kind;
  if (!kind) return;

  if (kind === 'user_text') { renderUserBubble(evt.text || ''); return; }
  if (kind === 'assistant_text') { renderAssistantBubble(evt.text || ''); return; }
  if (kind === 'assistant_thinking') {
    removeEmptyState();
    const row = el('div', 'msg-row assistant');
    row.appendChild(el('div', 'msg-thinking', '(reasoning…)'));
    appendNode(row);
    return;
  }
  if (kind === 'tool_use') { renderToolUseCard(evt); return; }
  if (kind === 'tool_result') { updateToolResultBody(evt); return; }
  if (kind === 'unknown') {
    // Quietly drop in the live view — these are mostly metadata frames we
    // didn't filter at the normalizer (keeps the read-only feed clean).
    return;
  }

  // Fallback for anything else
  const label = kind || 'unknown';
  const json = JSON.stringify(evt, null, 2);
  renderCard('help-circle', label, '<pre>' + escapeHtml(json) + '</pre>', false);
}

// Cancel any in-flight chunked render before starting a new one (e.g. on WS
// reconnect / re-entry).
let _renderToken = 0;

function renderTranscript(events) {
  const inner = getMessagesInner();
  // Wipe both message rows and any leftover load-earlier button from a
  // prior render so re-entry doesn't double up.
  const existing = inner.querySelectorAll('.msg-row, .live-load-earlier, .live-streaming-indicator');
  existing.forEach((n) => n.remove());
  toolUseElements.clear();
  // Invalidate any earlier streaming pass.
  _renderToken += 1;
  const myToken = _renderToken;

  if (!events || events.length === 0) {
    if (!inner.querySelector('.chat-empty')) {
      const es = el('div', 'chat-empty');
      es.id = 'emptyState';
      es.innerHTML =
        '<i data-lucide="messages-square"></i>' +
        '<span>아직 메시지가 없습니다</span>';
      inner.appendChild(es);
      renderIcons();
    }
    state.hasMessages = false;
    return;
  }
  state.hasMessages = false;

  // Render strategy: never block the main thread synchronously.
  // - Tail (last TAIL_RENDER) streams in immediately in CHUNK_SIZE batches via
  //   requestIdleCallback / setTimeout. UI stays interactive during this.
  // - Head (everything older) is hidden behind a "load earlier" button.
  // Heavy events (tool_use with diffs, large code blocks) are common, so even
  // small chunk sizes are necessary on mobile Safari.
  const TAIL_RENDER = 60;
  const CHUNK_SIZE  = 8;

  const tailStart = Math.max(0, events.length - TAIL_RENDER);
  const tail = events.slice(tailStart);
  const head = events.slice(0, tailStart);

  // Streaming indicator while tail loads
  const streamHint = el('div', 'live-streaming-indicator');
  streamHint.innerHTML = '<i data-lucide="loader-2"></i><span>대화 불러오는 중…</span>';
  inner.appendChild(streamHint);
  renderIcons();

  let i = 0;
  function nextTailChunk() {
    if (myToken !== _renderToken) return; // superseded by another renderTranscript
    if (i >= tail.length) {
      streamHint.remove();
      if (head.length > 0) insertLoadEarlierButton(head, myToken);
      scrollToBottom(true);
      return;
    }
    const slice = tail.slice(i, i + CHUNK_SIZE);
    for (const ev of slice) renderEvent(ev);
    i += CHUNK_SIZE;
    if (state.pinned) scrollToBottom(false);
    schedule(nextTailChunk);
  }
  schedule(nextTailChunk);
}

function schedule(fn) {
  if (window.requestIdleCallback) requestIdleCallback(fn, { timeout: 120 });
  else setTimeout(fn, 0);
}

function insertLoadEarlierButton(headEvents, ownerToken) {
  const inner = getMessagesInner();
  const loadBtn = el('button', 'live-load-earlier');
  loadBtn.type = 'button';
  loadBtn.innerHTML = '<i data-lucide="chevron-up"></i><span>이전 메시지 ' + headEvents.length + '개 더 보기</span>';
  inner.insertBefore(loadBtn, inner.firstChild);
  renderIcons();

  loadBtn.addEventListener('click', function onClick() {
    loadBtn.removeEventListener('click', onClick);
    loadBtn.disabled = true;
    const label = loadBtn.querySelector('span');
    const CHUNK = 8;
    let i = 0;
    function tick() {
      if (ownerToken !== _renderToken) { loadBtn.remove(); return; }
      const slice = headEvents.slice(i, i + CHUNK);
      if (slice.length === 0) {
        loadBtn.remove();
        return;
      }
      const collector = el('div');
      appendTargetOverride = collector;
      try { for (const ev of slice) renderEvent(ev); }
      finally { appendTargetOverride = null; }

      const prevScrollHeight = chatMessages.scrollHeight;
      const prevScrollTop = chatMessages.scrollTop;

      // Maintain chronological order: track last inserted node and insert after it
      const anchor = loadBtn._lastInserted || loadBtn;
      let lastNode = anchor;
      while (collector.firstChild) {
        const node = collector.firstChild;
        lastNode.after(node);
        lastNode = node;
      }
      loadBtn._lastInserted = lastNode;

      chatMessages.scrollTop = prevScrollTop + (chatMessages.scrollHeight - prevScrollHeight);

      i += CHUNK;
      label.textContent = '불러오는 중… (' + Math.min(i, headEvents.length) + '/' + headEvents.length + ')';
      renderIcons();
      schedule(tick);
    }
    tick();
  });
}

// ─── Header / meta updates ───────────────────────────────────────────────────
function fmtIdleSeconds(s) {
  if (s == null || !Number.isFinite(s)) return '';
  if (s < 60) return s + '초';
  if (s < 3600) return Math.floor(s / 60) + '분';
  return Math.floor(s / 3600) + '시간 ' + Math.floor((s % 3600) / 60) + '분';
}

function setBusyUI(busy) {
  if (busy) {
    busyIndicator.classList.add('visible');
  } else {
    busyIndicator.classList.remove('visible');
  }
}

function applyMeta(meta) {
  if (!meta) return;
  state.meta = meta;

  // Project label = basename of cwd, or short sessionId
  let label;
  if (meta.cwd) {
    label = meta.cwd.split('/').filter(Boolean).pop() || meta.cwd;
  } else {
    label = (meta.sessionId || '').slice(0, 8);
  }
  projectLabel.textContent = label;
  document.title = label + ' — Working in the Moon (live)';

  // Source chip: show "cmux", "tmux", or "terminal" based on availability.
  // We derive it from meta fields rather than meta.source so it stays in sync
  // with the input-bar enablement logic.
  updateSourceChip(!!meta.cmuxAvailable, !!meta.tmuxAvailable);

  if (meta.cwd) {
    liveCwd.textContent = meta.cwd;
    liveCwd.title = meta.cwd;
  } else {
    liveCwd.textContent = '';
  }

  if (meta.pid != null) {
    livePid.textContent = 'PID ' + meta.pid;
  } else {
    livePid.textContent = '프로세스 종료됨';
  }

  if (meta.startedAt) {
    try {
      const d = new Date(meta.startedAt);
      liveStartedAt.textContent = '시작 ' + d.toLocaleTimeString();
    } catch (_) { liveStartedAt.textContent = ''; }
  } else {
    liveStartedAt.textContent = '';
  }

  applyBusyMeta(meta.busy === true, meta.idleSeconds);
  applyCmuxMeta({
    available: !!meta.cmuxAvailable,
    surfaceId: meta.cmuxSurfaceId || null,
    workspaceId: meta.cmuxWorkspaceId || null
  });
  applyTmuxMeta({
    available: !!meta.tmuxAvailable,
    socketPath: meta.tmuxSocketPath || null,
    paneId: meta.tmuxPaneId || null
  });
}

function applyBusyMeta(busy, idleSeconds) {
  setBusyUI(busy);
  liveStatus.classList.remove('busy');
  liveStatus.classList.remove('idle');
  const labelEl = liveStatus.querySelector('.label');
  if (busy) {
    liveStatus.classList.add('busy');
    if (labelEl) labelEl.textContent = '다른 곳에서 사용 중';
  } else {
    liveStatus.classList.add('idle');
    if (labelEl) {
      const idleStr = idleSeconds != null ? ' (' + fmtIdleSeconds(idleSeconds) + ')' : '';
      labelEl.textContent = '입력 대기 중' + idleStr;
    }
  }
}

// ─── cmux / tmux input bar ────────────────────────────────────────────────────

// Returns true when at least one forwarding backend is active.
function isForwardingAvailable() {
  const cmuxOk = !!(state.cmux && state.cmux.available && state.cmux.surfaceId);
  const tmuxOk = !!(state.tmux && state.tmux.available && state.tmux.paneId);
  return cmuxOk || tmuxOk;
}

function applyCmuxMeta(cmux) {
  state.cmux = cmux || { available: false, surfaceId: null, workspaceId: null };
  setInputBarStatus();
}

function applyTmuxMeta(tmux) {
  state.tmux = tmux || { available: false, socketPath: null, paneId: null };
  setInputBarStatus();
}

// Update the source chip (liveSourcePill) to show "cmux", "tmux", or "terminal".
// Reuses the existing .live-source-pill element; does NOT recreate the DOM node.
function updateSourceChip(cmuxAvail, tmuxAvail) {
  if (!liveSourcePill) return;
  let label, dataSource;
  if (cmuxAvail) {
    label = 'cmux';
    dataSource = 'cmux';
  } else if (tmuxAvail) {
    label = 'tmux';
    dataSource = 'tmux';
  } else {
    label = 'terminal';
    dataSource = 'terminal';
  }
  liveSourcePill.textContent = label;
  liveSourcePill.dataset.source = dataSource;
  liveSourcePill.hidden = false;
}

function setInputBarStatus() {
  if (!liveTextarea || !liveSendBtn || !liveCmuxStatus) return;
  const available = isForwardingAvailable();
  if (available) {
    liveTextarea.disabled = false;
    liveCmuxStatus.classList.remove('unavailable');
    const backend = (state.cmux && state.cmux.available && state.cmux.surfaceId) ? 'cmux' : 'tmux';
    liveCmuxStatus.textContent = isTouchDevice
      ? backend + ' 연동 활성 — 전송 버튼으로 보내기'
      : backend + ' 연동 활성 — Enter로 전송, Shift+Enter 줄바꿈';
    updateSendBtnEnabled();
  } else {
    liveTextarea.disabled = true;
    liveSendBtn.disabled = true;
    liveCmuxStatus.classList.add('unavailable');
    liveCmuxStatus.textContent = '외부 세션 연결이 없습니다.';
  }
}

function updateSendBtnEnabled() {
  if (!liveSendBtn || !liveTextarea) return;
  const available = isForwardingAvailable();
  const hasText = liveTextarea.value.trim().length > 0;
  liveSendBtn.disabled = !(available && hasText);
}

function autoResizeLiveTextarea() {
  if (!liveTextarea) return;
  liveTextarea.style.height = 'auto';
  const maxH = parseInt(getComputedStyle(liveTextarea).maxHeight, 10) || 240;
  const scrollH = liveTextarea.scrollHeight;
  liveTextarea.style.height = Math.min(scrollH, maxH) + 'px';
}

function sendLiveText() {
  if (!liveTextarea) return;
  const raw = liveTextarea.value;
  const text = raw.trim();
  if (!text) return;
  if (!isForwardingAvailable()) {
    showToast('외부 세션 연결이 없습니다.', 'error');
    return;
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('연결이 끊어졌습니다.', 'error');
    return;
  }
  // Trailing \n submits in claude TUI (cmux/tmux normalize \n → \r for the pty).
  state.ws.send(JSON.stringify({ type: 'send', text: text + '\n' }));
  liveTextarea.value = '';
  autoResizeLiveTextarea();
  updateSendBtnEnabled();
}

const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
let liveIsComposing = false;

if (liveTextarea) {
  liveTextarea.addEventListener('compositionstart', () => { liveIsComposing = true; });
  liveTextarea.addEventListener('compositionend',   () => { liveIsComposing = false; });

  liveTextarea.addEventListener('input', () => {
    autoResizeLiveTextarea();
    updateSendBtnEnabled();
  });

  liveTextarea.addEventListener('keydown', (e) => {
    // Cmd/Ctrl+Enter always sends (overrides IME / touch).
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendLiveText();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !liveIsComposing && !e.isComposing) {
      // Touch devices: Enter inserts newline (send only via button).
      if (isTouchDevice) return;
      e.preventDefault();
      sendLiveText();
    }
  });
}

if (liveSendBtn) {
  liveSendBtn.addEventListener('click', () => { sendLiveText(); });
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function openWS() {
  setConnState('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/ws/live');
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.reconnectAttempted = false;
    setConnState('connected');
    const hello = { type: 'hello' };
    if (state.sessionId) hello.sessionId = state.sessionId;
    else if (state.cwd) hello.cwd = state.cwd;
    ws.send(JSON.stringify(hello));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    const type = msg.type;

    if (type === 'init') {
      // Apply meta synchronously so the input bar / cmux status / connection
      // dot reflect reality immediately.
      applyMeta(msg.meta);
      // Defer transcript render to the next paint tick so the meta DOM updates
      // become visible BEFORE the (potentially heavy) chunked render begins.
      // Without this, on long transcripts the user sees "cmux 연동 확인 중…"
      // until the entire stream finishes.
      const events = msg.transcript || [];
      requestAnimationFrame(() => {
        requestAnimationFrame(() => renderTranscript(events));
      });
      return;
    }
    if (type === 'event') {
      renderEvent(msg);
      return;
    }
    if (type === 'meta_update') {
      if (state.meta) {
        if (msg.pid != null) state.meta.pid = msg.pid;
        state.meta.busy = msg.busy === true;
        state.meta.idleSeconds = msg.idleSeconds;
        if ('cmuxAvailable' in msg) state.meta.cmuxAvailable = !!msg.cmuxAvailable;
        if ('cmuxSurfaceId' in msg) state.meta.cmuxSurfaceId = msg.cmuxSurfaceId || null;
        if ('cmuxWorkspaceId' in msg) state.meta.cmuxWorkspaceId = msg.cmuxWorkspaceId || null;
        if ('tmuxAvailable' in msg) state.meta.tmuxAvailable = !!msg.tmuxAvailable;
        if ('tmuxSocketPath' in msg) state.meta.tmuxSocketPath = msg.tmuxSocketPath || null;
        if ('tmuxPaneId' in msg) state.meta.tmuxPaneId = msg.tmuxPaneId || null;
      }
      applyBusyMeta(msg.busy === true, msg.idleSeconds);
      if (msg.pid != null && livePid) livePid.textContent = 'PID ' + msg.pid;
      // cmux/tmux fields are only included when the server detects a flip — but
      // it's safe to call apply*Meta whenever they are present.
      if ('cmuxAvailable' in msg) {
        applyCmuxMeta({
          available: !!msg.cmuxAvailable,
          surfaceId: msg.cmuxSurfaceId || null,
          workspaceId: msg.cmuxWorkspaceId || null
        });
      }
      if ('tmuxAvailable' in msg) {
        applyTmuxMeta({
          available: !!msg.tmuxAvailable,
          socketPath: msg.tmuxSocketPath || null,
          paneId: msg.tmuxPaneId || null
        });
      }
      // Re-sync source chip whenever either backend field arrives.
      if ('cmuxAvailable' in msg || 'tmuxAvailable' in msg) {
        const cmuxAvail = !!(state.meta && state.meta.cmuxAvailable);
        const tmuxAvail = !!(state.meta && state.meta.tmuxAvailable);
        updateSourceChip(cmuxAvail, tmuxAvail);
      }
      return;
    }
    if (type === 'process_exit') {
      showToast('외부 프로세스가 종료되었습니다.', 'info');
      if (state.meta) state.meta.pid = null;
      if (livePid) livePid.textContent = '프로세스 종료됨';
      applyBusyMeta(false, null);
      // Disable input — all forwarding surfaces are gone.
      applyCmuxMeta({ available: false, surfaceId: null, workspaceId: null });
      applyTmuxMeta({ available: false, socketPath: null, paneId: null });
      updateSourceChip(false, false);
      return;
    }
    if (type === 'error') {
      showToast(msg.message || '오류가 발생했습니다.', 'error');
      return;
    }
    if (type === 'closed') {
      // Server is closing the socket; the close event will follow.
      return;
    }
  });

  ws.addEventListener('close', () => {
    state.ws = null;
    setConnState('disconnected');
    if (!state.reconnectAttempted) {
      state.reconnectAttempted = true;
      setConnState('connecting');
      setTimeout(() => {
        try { openWS(); } catch (_) {
          setConnState('disconnected');
          showDisconnectBanner();
        }
      }, 2000);
    } else {
      showDisconnectBanner();
    }
  });

  ws.addEventListener('error', () => {
    // close fires next; handled there
  });
}

function showDisconnectBanner() {
  if (disconnectBanner) {
    disconnectBanner.style.display = 'flex';
    renderIcons();
  }
}

if (refreshBtn) {
  refreshBtn.addEventListener('click', () => { location.reload(); });
}

// ─── Boot ────────────────────────────────────────────────────────────────────
{
  const validSid = state.sessionId
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(state.sessionId);
  const validCwd = state.cwd && state.cwd.charAt(0) === '/';
  if (!validSid && !validCwd) {
    showToast('잘못된 세션 ID 또는 경로입니다.', 'error');
  } else {
    openWS();
  }
}
