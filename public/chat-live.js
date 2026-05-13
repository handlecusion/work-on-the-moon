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

// ─── Timeout constants ────────────────────────────────────────────────────────
const WS_CONNECT_TIMEOUT_MS = 5000;
const WS_INIT_TIMEOUT_MS    = 15000;

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  pinned: true,
  hasMessages: false,
  reconnectAttempted: false,
  _connectTimer: null,
  _initTimer: null,
  _lastFailReason: null,  // 'connect_timeout' | 'init_timeout' | null
  ws: null,
  connected: false,
  meta: null,
  sessionId: null,
  cmux: { available: false, surfaceId: null, workspaceId: null },
  tmux: { available: false, socketPath: null, paneId: null },

  // Pagination state for server-side "load earlier" chunks
  transcript: { oldestStartIdx: 0, hasEarlier: false, loading: false },

  // Pending file attachments (uploaded before send)
  attach: {
    pending: [],    // [{ id, name, mime, size, status, absPath, thumbUrl, error, xhr }]
    nextLocalId: 1,
  },

  // Slash command picker
  slash: {
    open: false,
    query: '',
    items: [],       // all commands flattened
    filtered: [],    // current filtered+sorted list (top 30)
    activeIndex: 0,
    fetched: false,
    fetchedAgent: null,
  },

  // Optimistic-echo bookkeeping for tmux/cmux sends.
  // Each entry: { text, sentAt, node, confirmed }
  // We dedupe arriving user_text events against the head of this queue so
  // that a real jsonl echo replaces (not duplicates) the optimistic bubble.
  pendingSends: [],

  // Terminal preview (HITL surfacing) state.
  terminal: {
    open: false,
    pollTimer: null,
    inflight: false,
    lastUpdated: null,
    lastSource: null,
  },

  // Live TUI picker overlay state. The detector parses each capture-pane
  // snapshot for a numbered-option picker (claude AskUserQuestion / codex /
  // hermes interactive prompts). When detected, an overlay above the input
  // bar shows tappable buttons that send "<N>+Enter" via the existing send
  // path. Signature dedupes identical pickers so we don't re-render on every
  // poll.
  tuiPicker: {
    signature: null,    // string — question + options joined
    active: false,
    pending: false,     // user clicked, awaiting TUI advance
    pendingIdx: -1,
    localHl: -1,        // local highlight index (keyboard nav); -1 = follow TUI
    optionCount: 0,
    typeSomethingIdx: -1, // index of "Type something" / free-form option, or -1
  },
};

// Module-level agent — set from init meta. Default 'claude' until init arrives;
// fetchSlashCommands re-runs on agent change.
let liveAgent = 'claude';

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
const liveAttachStrip    = $('liveAttachStrip');
const liveAttachBtn      = $('liveAttachBtn');
const liveFileInput      = $('liveFileInput');
const liveLoadEarlierBtn = $('liveLoadEarlierBtn');
const agentMark          = $('agentMark');
const favicon            = document.getElementById('favicon');
const slashPicker        = $('slashPicker');
const slashPickerList    = $('slashPickerList');
const slashPickerEmpty   = $('slashPickerEmpty');
const liveTerminalPanel   = $('liveTerminalPanel');
const liveTerminalToggle  = $('liveTerminalToggle');
const liveTerminalRefresh = $('liveTerminalRefresh');
const liveTerminalStatus  = $('liveTerminalStatus');
const tuiPickerOverlay    = $('tuiPickerOverlay');

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

// True while replaying the transcript tail chunks at session open. Used to
// distinguish "historical event being re-rendered" from "live event just
// arrived via WS", so AskUserQuestion doesn't try to grab attention for
// old pickers that were already answered.
let isHistoricalReplay = false;

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
  // If a recent optimistic send matches this incoming user_text, mark the
  // optimistic bubble as confirmed instead of rendering a duplicate.
  const matched = consumePendingSend(text);
  if (matched && matched.node && matched.node.isConnected) {
    matched.node.classList.add('confirmed');
    return;
  }
  const row = el('div', 'msg-row user');
  const bubble = el('div', 'msg-bubble', escapeHtml(text));
  row.appendChild(bubble);
  appendNode(row);
}

// Render the bubble client-side immediately when the user hits send. The real
// jsonl echo (if any — TUI menu picks like "1" never make it to jsonl) will
// confirm via consumePendingSend(). Returns the bubble node so the caller can
// stash it on the pending-send entry.
function renderOptimisticUserBubble(text) {
  const row = el('div', 'msg-row user');
  const bubble = el('div', 'msg-bubble optimistic', escapeHtml(text));
  row.appendChild(bubble);
  appendNode(row);
  return bubble;
}

const PENDING_SEND_TTL_MS = 60 * 1000;

function normalizeForDedupe(s) {
  // Strip a single trailing newline (sendLiveText appends '\n' for submit) and
  // collapse CRLF before comparison.
  return String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

function consumePendingSend(incomingText) {
  const target = normalizeForDedupe(incomingText);
  const now = Date.now();
  // Drop expired entries first.
  state.pendingSends = state.pendingSends.filter((p) => (now - p.sentAt) < PENDING_SEND_TTL_MS);
  for (let i = 0; i < state.pendingSends.length; i++) {
    const p = state.pendingSends[i];
    if (normalizeForDedupe(p.text) === target) {
      state.pendingSends.splice(i, 1);
      return p;
    }
  }
  return null;
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

// ─── AskUserQuestion picker ───────────────────────────────────────────────────
// Renders claude's AskUserQuestion tool_use as an inline button picker so the
// user can answer with a tap from the chat view. Clicking a single-select
// option sends "<1-based index>\n" via the existing tmux/cmux forwarding path,
// which the claude TUI picker accepts as "select option N + submit".

function buildAskPicker(questions, opts) {
  // opts: { onPick: (qIdx, optIdx, label) => void, highlightedIdx?: number }
  const onPick = opts && typeof opts.onPick === 'function' ? opts.onPick : null;
  const highlightedIdx = opts && Number.isFinite(opts.highlightedIdx) ? opts.highlightedIdx : -1;

  const root = el('div', 'ask-picker');
  const list = Array.isArray(questions) ? questions : [];
  list.forEach((q, qIdx) => {
    const qBlock = el('div', 'ask-question');
    qBlock.dataset.qText = q && q.question ? String(q.question) : '';
    if (q && q.header) {
      const hdr = el('span', 'ask-header', escapeHtml(String(q.header)));
      qBlock.appendChild(hdr);
    }
    const qTxt = el('div', 'ask-text', escapeHtml(String((q && q.question) || '')));
    qBlock.appendChild(qTxt);

    const isMulti = !!(q && q.multiSelect);
    const optionsArr = Array.isArray(q && q.options) ? q.options : [];
    const listEl = el('div', 'ask-options' + (isMulti ? ' is-multi' : ''));

    optionsArr.forEach((o, optIdx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ask-option' + (optIdx === highlightedIdx ? ' tui-highlighted' : '');
      btn.dataset.qIdx = String(qIdx);
      btn.dataset.optIdx = String(optIdx);
      btn.dataset.label = String((o && o.label) || '');
      btn.innerHTML =
        '<span class="ask-option-num">' + (optIdx + 1) + '</span>' +
        '<span class="ask-option-label">' + escapeHtml(String((o && o.label) || '')) + '</span>' +
        (o && o.description ? '<span class="ask-option-desc">' + escapeHtml(String(o.description)) + '</span>' : '');
      if (isMulti) {
        btn.disabled = true;
        btn.title = '다중 선택은 터미널에서 직접 응답하세요';
      } else if (onPick) {
        btn.addEventListener('click', () => onPick(qIdx, optIdx, String((o && o.label) || '')));
      } else {
        btn.disabled = true;
      }
      listEl.appendChild(btn);
    });
    qBlock.appendChild(listEl);
    if (isMulti) {
      const note = el('div', 'ask-multi-note', '다중 선택 질문은 터미널에서 직접 응답하세요.');
      qBlock.appendChild(note);
    }
    root.appendChild(qBlock);
  });
  return root;
}

function onAskOptionPick(toolUseId, qIdx, optIdx) {
  if (!isForwardingAvailable() || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('외부 세션 연결이 없어 답변 전송 불가', 'error');
    return;
  }
  // claude TUI picker accepts <N><Enter>. tmuxClient peels trailing \n into a
  // separate Enter key, so the pasted "<N>" arrives first, then the Enter.
  const text = String(optIdx + 1) + '\n';
  try {
    state.ws.send(JSON.stringify({ type: 'send', text }));
  } catch (_) { return; }

  if (toolUseId && toolUseElements.has(toolUseId)) {
    const { card } = toolUseElements.get(toolUseId);
    const btn = card.querySelector(
      '.ask-option[data-q-idx="' + qIdx + '"][data-opt-idx="' + optIdx + '"]'
    );
    if (btn) {
      btn.classList.add('sent');
      const qBlock = btn.closest('.ask-question');
      if (qBlock) qBlock.querySelectorAll('.ask-option').forEach((b) => { b.disabled = true; });
    }
  }
  if (state.terminal.open) setTimeout(refreshTerminalPreview, 250);
}

function parseAskAnswers(content) {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.map((c) => (c && typeof c.text === 'string') ? c.text : '').join('');
  }
  const out = {};
  const re = /"([^"]+)"="([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2];
  return out;
}

function lockAskPicker(card, answers) {
  if (!card) return;
  card.querySelectorAll('.ask-question').forEach((qBlock) => {
    const qText = qBlock.dataset.qText || '';
    const chosen = answers[qText];
    qBlock.querySelectorAll('.ask-option').forEach((b) => {
      b.disabled = true;
      if (chosen && b.dataset.label === chosen) b.classList.add('chosen');
    });
  });
}

function renderToolUseCard(evt) {
  const name = evt.name || 'unknown';
  // Codex normalizer may deliver input as a JSON string; parse defensively.
  let input = evt.input || {};
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch (_) { input = { _raw: input }; }
  }
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
    case 'AskUserQuestion': {
      iconName = 'help-circle'; labelText = '질문';
      const qs = Array.isArray(input.questions) ? input.questions : [];
      pillText = qs.length > 1 ? qs.length + '개' : null;
      bodyNodeOrHtml = buildAskPicker(qs, {
        onPick: (qIdx, optIdx) => onAskOptionPick(toolUseId, qIdx, optIdx),
      });
      bodyClass = 'tool-body-ask';
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

  // AskUserQuestion is a call-to-action — the picker buttons must be visible
  // on arrival, not hidden behind the default collapsed header. Force the
  // card into the expanded state so the user can answer immediately.
  const isAsk = name === 'AskUserQuestion';
  if (isAsk) {
    card.classList.add('expanded');
    const header = card.querySelector('.msg-card-header');
    if (header) {
      header.setAttribute('aria-expanded', 'true');
      const toggle = header.querySelector('.card-toggle');
      if (toggle) toggle.innerHTML = '<i data-lucide="chevron-up"></i>';
    }
  }

  const row = el('div', 'msg-row assistant');
  row.appendChild(card);
  appendNode(row);

  // For live-tailed AskUserQuestion (not historical transcript replay, not
  // load-earlier paginated fragment), scroll the picker into view AND unpin
  // from bottom. Without unpinning, every subsequent event's appendNode()
  // calls scrollToBottom() which yanks the viewport away from the picker
  // before the user has a chance to read it.
  if (isAsk && appendTargetOverride === null && !isHistoricalReplay) {
    console.log('[wotm] AskUserQuestion picker arrived (live) — centering view', { toolUseId });
    state.pinned = false;
    if (typeof scrollBtn !== 'undefined' && scrollBtn) scrollBtn.classList.add('visible');
    requestAnimationFrame(() => {
      try { card.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (_) {}
    });
  }
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
    case 'AskUserQuestion': {
      // Keep the picker visible; just lock it and mark the chosen option.
      lockAskPicker(card, parseAskAnswers(content));
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
    if (myToken !== _renderToken) {
      isHistoricalReplay = false;
      return; // superseded by another renderTranscript
    }
    if (i >= tail.length) {
      streamHint.remove();
      if (head.length > 0) insertLoadEarlierButton(head, myToken);
      scrollToBottom(true);
      isHistoricalReplay = false;
      return;
    }
    isHistoricalReplay = true;
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

  // Agent icon + favicon swap
  const agent = meta.agent || 'claude';
  liveAgent = agent;
  const agentIconSrc = agent === 'codex'
    ? '/static/icons/openai.svg'
    : (agent === 'hermes'
        ? '/static/icons/hermes.svg'
        : '/static/icons/anthropic.svg');
  if (agentMark) {
    agentMark.src = agentIconSrc;
    agentMark.hidden = false;
  }
  if (favicon) {
    favicon.href = agentIconSrc;
  }

  document.title = label + ' — Working in the Moon (live ' + agent + ')';

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

// ─── Attachments ─────────────────────────────────────────────────────────────

const ATTACH_LIMIT      = 5;
const ATTACH_MAX_BYTES  = 10 * 1024 * 1024;
const ALLOWED_MIME_PREFIX = ['image/', 'application/pdf', 'text/'];

function isAllowedMime(mime) {
  if (!mime) return false;
  return ALLOWED_MIME_PREFIX.some((p) => mime === p || mime.startsWith(p));
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function getLiveProjectName() {
  if (state.meta && state.meta.cwd) {
    const parts = state.meta.cwd.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : null;
  }
  return null;
}

function renderLiveAttachStrip() {
  if (!liveAttachStrip) return;
  if (state.attach.pending.length === 0) {
    liveAttachStrip.setAttribute('hidden', '');
    liveAttachStrip.innerHTML = '';
    return;
  }
  liveAttachStrip.removeAttribute('hidden');
  liveAttachStrip.innerHTML = '';
  for (const a of state.attach.pending) {
    const chip = document.createElement('div');
    chip.className = 'chat-attach-chip' + (a.status === 'error' ? ' error' : '');
    chip.dataset.id = String(a.id);

    const thumb = document.createElement('div');
    thumb.className = 'chat-attach-chip-thumb';
    if (a.thumbUrl) {
      const img = document.createElement('img');
      img.src = a.thumbUrl;
      img.alt = '';
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = '<i data-lucide="file"></i>';
    }
    chip.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'chat-attach-chip-meta';
    const name = document.createElement('span');
    name.className = 'chat-attach-chip-name';
    name.textContent = a.name;
    meta.appendChild(name);
    const sub = document.createElement('span');
    sub.className = 'chat-attach-chip-sub';
    if (a.status === 'uploading') sub.textContent = '업로드 중…';
    else if (a.status === 'error') sub.textContent = a.error || '오류';
    else sub.textContent = formatBytes(a.size);
    meta.appendChild(sub);
    chip.appendChild(meta);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'chat-attach-chip-remove';
    removeBtn.setAttribute('aria-label', '제거');
    removeBtn.innerHTML = '<i data-lucide="x"></i>';
    removeBtn.addEventListener('click', () => removeLiveAttachment(a.id));
    chip.appendChild(removeBtn);

    if (a.status === 'uploading') {
      const bar = document.createElement('div');
      bar.className = 'chat-attach-chip-progress';
      bar.style.width = (a.progress || 5) + '%';
      chip.appendChild(bar);
    }

    liveAttachStrip.appendChild(chip);
  }
  renderIcons();
}

function removeLiveAttachment(id) {
  const idx = state.attach.pending.findIndex((a) => a.id === id);
  if (idx === -1) return;
  const a = state.attach.pending[idx];
  if (a.thumbUrl) { try { URL.revokeObjectURL(a.thumbUrl); } catch (_) {} }
  if (a.xhr && a.status === 'uploading') {
    try { a.xhr.abort(); } catch (_) {}
  }
  state.attach.pending.splice(idx, 1);
  renderLiveAttachStrip();
  updateSendBtnEnabled();
}

function uploadOneLiveFile(file) {
  if (state.attach.pending.length >= ATTACH_LIMIT) {
    showToast('첨부는 최대 ' + ATTACH_LIMIT + '개까지 가능합니다.', 'info');
    return;
  }
  if (file.size > ATTACH_MAX_BYTES) {
    showToast(file.name + ' 은(는) 너무 큽니다 (최대 10MB)', 'error');
    return;
  }
  if (!isAllowedMime(file.type)) {
    showToast('지원하지 않는 형식: ' + (file.type || '알 수 없음'), 'error');
    return;
  }

  const projectName = getLiveProjectName();
  if (!projectName) {
    showToast('프로젝트를 식별할 수 없습니다.', 'error');
    return;
  }

  const localId = state.attach.nextLocalId++;
  const isImage = file.type.startsWith('image/');
  const thumbUrl = isImage ? URL.createObjectURL(file) : null;

  const entry = {
    id: localId,
    name: file.name || 'file',
    mime: file.type || 'application/octet-stream',
    size: file.size,
    status: 'uploading',
    progress: 5,
    absPath: null,
    thumbUrl,
    error: null,
    xhr: null,
  };
  state.attach.pending.push(entry);
  renderLiveAttachStrip();
  updateSendBtnEnabled();

  const xhr = new XMLHttpRequest();
  entry.xhr = xhr;
  xhr.open('POST', '/api/projects/' + encodeURIComponent(projectName) + '/upload');
  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    entry.progress = Math.max(5, Math.round((e.loaded / e.total) * 100));
    const chip = liveAttachStrip && liveAttachStrip.querySelector('.chat-attach-chip[data-id="' + entry.id + '"] .chat-attach-chip-progress');
    if (chip) chip.style.width = entry.progress + '%';
  });
  xhr.onload = () => {
    entry.xhr = null;
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        const data = JSON.parse(xhr.responseText);
        const f = (data.files || [])[0];
        if (f && f.absPath) {
          entry.status = 'ready';
          entry.absPath = f.absPath;
          if (typeof f.name === 'string') entry.name = f.name;
          if (typeof f.size === 'number') entry.size = f.size;
          if (typeof f.mime === 'string') entry.mime = f.mime;
        } else {
          entry.status = 'error';
          entry.error = '서버 응답 오류';
        }
      } catch (_) {
        entry.status = 'error';
        entry.error = '서버 응답 파싱 실패';
      }
    } else {
      entry.status = 'error';
      try {
        const data = JSON.parse(xhr.responseText);
        entry.error = data.error || ('HTTP ' + xhr.status);
      } catch (_) {
        entry.error = 'HTTP ' + xhr.status;
      }
      showToast('업로드 실패: ' + entry.error, 'error');
    }
    renderLiveAttachStrip();
    updateSendBtnEnabled();
  };
  xhr.onerror = () => {
    entry.xhr = null;
    entry.status = 'error';
    entry.error = '네트워크 오류';
    renderLiveAttachStrip();
    updateSendBtnEnabled();
  };

  const fd = new FormData();
  fd.append('file', file, file.name);
  xhr.send(fd);
}

function handleLiveFileList(fileList) {
  if (!fileList) return;
  const files = Array.from(fileList);
  for (const f of files) {
    if (state.attach.pending.length >= ATTACH_LIMIT) {
      showToast('첨부 한도 도달 (최대 ' + ATTACH_LIMIT + '개)', 'info');
      break;
    }
    uploadOneLiveFile(f);
  }
}

if (liveAttachBtn && liveFileInput) {
  liveAttachBtn.addEventListener('click', () => {
    liveFileInput.click();
  });
  liveFileInput.addEventListener('change', () => {
    handleLiveFileList(liveFileInput.files);
    liveFileInput.value = '';
  });
}

// Paste support: capture image/file blobs from the clipboard.
if (liveTextarea) {
  liveTextarea.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items || items.length === 0) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      for (const f of files) uploadOneLiveFile(f);
    }
  });
}

// Drag-and-drop support: accept drop anywhere on the page.
{
  let liveDragDepth = 0;
  function isFileDrag(e) {
    if (!e.dataTransfer) return false;
    return Array.from(e.dataTransfer.types || []).includes('Files');
  }
  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    liveDragDepth++;
    document.querySelector('.chat-page')?.classList.add('drop-target');
  });
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    liveDragDepth = Math.max(0, liveDragDepth - 1);
    if (liveDragDepth === 0) {
      document.querySelector('.chat-page')?.classList.remove('drop-target');
    }
  });
  window.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    liveDragDepth = 0;
    document.querySelector('.chat-page')?.classList.remove('drop-target');
    if (e.dataTransfer && e.dataTransfer.files) handleLiveFileList(e.dataTransfer.files);
  });
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
  if (typeof ensureCapturePolling === 'function') ensureCapturePolling();
}

function applyTmuxMeta(tmux) {
  state.tmux = tmux || { available: false, socketPath: null, paneId: null };
  setInputBarStatus();
  if (typeof ensureCapturePolling === 'function') ensureCapturePolling();
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
    if (liveAttachBtn) liveAttachBtn.disabled = false;
    liveCmuxStatus.classList.remove('unavailable');
    const backend = (state.cmux && state.cmux.available && state.cmux.surfaceId) ? 'cmux' : 'tmux';
    liveCmuxStatus.textContent = isTouchDevice
      ? backend + ' 연동 활성 — 전송 버튼으로 보내기'
      : backend + ' 연동 활성 — Enter로 전송, Shift+Enter 줄바꿈';
    updateSendBtnEnabled();
  } else {
    liveTextarea.disabled = true;
    if (liveAttachBtn) liveAttachBtn.disabled = true;
    liveSendBtn.disabled = true;
    liveCmuxStatus.classList.add('unavailable');
    liveCmuxStatus.textContent = '외부 세션 연결이 없습니다.';
  }
}

function updateSendBtnEnabled() {
  if (!liveSendBtn || !liveTextarea) return;
  const available = isForwardingAvailable();
  const hasText = liveTextarea.value.trim().length > 0;
  const hasReady = state.attach.pending.some((a) => a.status === 'ready');
  const anyUploading = state.attach.pending.some((a) => a.status === 'uploading');
  liveSendBtn.disabled = !(available && (hasText || hasReady) && !anyUploading);
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
  const ready = state.attach.pending.filter((a) => a.status === 'ready');
  const anyUploading = state.attach.pending.some((a) => a.status === 'uploading');
  if (anyUploading) return;
  const rawText = liveTextarea.value.trim();
  if (!rawText && ready.length === 0) return;
  if (!isForwardingAvailable()) {
    showToast('외부 세션 연결이 없습니다.', 'error');
    return;
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('연결이 끊어졌습니다.', 'error');
    return;
  }
  // Prepend @-prefixed absolute paths so the claude TUI picks them up as file refs.
  let text = rawText;
  if (ready.length > 0) {
    const refs = ready.map((a) => '@' + a.absPath).join('\n');
    text = text ? (refs + '\n' + text) : refs;
  }
  // Trailing \n submits in claude TUI (cmux/tmux normalize \n → \r for the pty).
  state.ws.send(JSON.stringify({ type: 'send', text: text + '\n' }));

  // Optimistic echo: render the sent text immediately so the user sees it
  // landed. For prompt-mode sends the jsonl will eventually emit a matching
  // user_text and consumePendingSend() will mark this bubble as confirmed.
  // For TUI menu picks ("1", "y", etc.) no jsonl entry ever appears — the
  // bubble stays in the "전달 확인 대기" state and surfaces only that we sent
  // it, which is still better than the previous silent void.
  const optimisticNode = renderOptimisticUserBubble(text);
  state.pendingSends.push({
    text,
    sentAt: Date.now(),
    node: optimisticNode,
    confirmed: false
  });
  // Refresh the terminal preview right after a send so the user can immediately
  // see how the TUI reacted (HITL prompt, menu update, etc.) if they have it
  // open or if it gets opened.
  if (state.terminal.open) {
    setTimeout(refreshTerminalPreview, 250);
  }

  liveTextarea.value = '';
  // Clear attachments — revoke thumb URLs first.
  for (const a of state.attach.pending) {
    if (a.thumbUrl) { try { URL.revokeObjectURL(a.thumbUrl); } catch (_) {} }
  }
  state.attach.pending = [];
  renderLiveAttachStrip();
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
    updateSlashPicker();
  });

  liveTextarea.addEventListener('focus', () => {
    fetchSlashCommands();
  });

  liveTextarea.addEventListener('keydown', (e) => {
    // Slash picker navigation takes precedence over send-on-Enter.
    if (state.slash.open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.slash.activeIndex = Math.min(
          state.slash.activeIndex + 1,
          state.slash.filtered.length - 1
        );
        renderSlashList();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.slash.activeIndex = Math.max(state.slash.activeIndex - 1, 0);
        renderSlashList();
        return;
      }
      if (e.key === 'Enter' && !liveIsComposing && !e.isComposing) {
        if (state.slash.filtered.length > 0) {
          e.preventDefault();
          insertSlashCommand(state.slash.activeIndex);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlashPicker();
        return;
      }
    }

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

// ─── Slash command picker ────────────────────────────────────────────────────

function fetchSlashCommands() {
  if (state.slash.fetched && state.slash.fetchedAgent === liveAgent) return;
  state.slash.fetched = true;
  state.slash.fetchedAgent = liveAgent;

  fetch('/api/slash-commands?agent=' + encodeURIComponent(liveAgent), { credentials: 'same-origin' })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then((data) => {
      const kindOrder = { 'built-in': 0, builtin: 0, plugin: 1, skill: 2, custom: 3, agent: 4 };
      const all = Array.isArray(data) ? data : [
        ...(data.built_in || []),
        ...(data.plugins  || []),
        ...(data.skills   || []),
        ...(data.custom   || []),
        ...(data.agents   || []),
      ];
      const seen = new Set();
      state.slash.items = all.filter((item) => {
        if (seen.has(item.name)) return false;
        seen.add(item.name);
        return true;
      }).sort((a, b) => {
        const ko = (kindOrder[a.kind] ?? 99) - (kindOrder[b.kind] ?? 99);
        if (ko !== 0) return ko;
        return a.name.localeCompare(b.name);
      });
      if (state.slash.open) updateSlashPicker();
    })
    .catch(() => {
      state.slash.fetched = false;
      state.slash.fetchedAgent = null;
    });
}

function fuzzyScore(name, query) {
  if (!query) return 1;
  const haystack = name.toLowerCase();
  const needle = query.toLowerCase().replace(/^\//, '');
  let hi = 0;
  let lastIdx = -1;
  let gaps = 0;
  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni];
    const found = haystack.indexOf(ch, hi);
    if (found === -1) return -1;
    if (lastIdx !== -1) gaps += found - lastIdx - 1;
    lastIdx = found;
    hi = found + 1;
  }
  const density = needle.length / haystack.length;
  const startBonus = haystack.startsWith(needle) ? 2 : (haystack.indexOf(needle) !== -1 ? 1 : 0);
  return density * 10 - gaps * 0.1 + startBonus;
}

function highlightSlashMatch(name, query) {
  if (!query) return escapeHtml(name);
  const needle = query.toLowerCase().replace(/^\//, '');
  if (!needle) return escapeHtml(name);
  const lower = name.toLowerCase();
  const result = [];
  let hi = 0;
  let ni = 0;
  while (ni < needle.length && hi < name.length) {
    const ch = needle[ni];
    const found = lower.indexOf(ch, hi);
    if (found === -1) break;
    if (found > hi) result.push(escapeHtml(name.slice(hi, found)));
    result.push('<mark>' + escapeHtml(name[found]) + '</mark>');
    hi = found + 1;
    ni++;
  }
  if (hi < name.length) result.push(escapeHtml(name.slice(hi)));
  return result.join('');
}

function filterSlash(query) {
  const items = state.slash.items;
  if (!items.length) {
    state.slash.filtered = [];
    return;
  }
  const scored = [];
  for (const item of items) {
    const score = fuzzyScore(item.name, query);
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  state.slash.filtered = scored.slice(0, 30).map((s) => s.item);
}

function renderSlashList() {
  if (!slashPickerList || !slashPickerEmpty) return;
  const filtered = state.slash.filtered;
  if (filtered.length === 0) {
    slashPickerList.innerHTML = '';
    slashPickerEmpty.hidden = false;
    return;
  }
  slashPickerEmpty.hidden = true;
  const activeIdx = state.slash.activeIndex;
  let html = '';
  for (let i = 0; i < filtered.length; i++) {
    const item = filtered[i];
    const activeClass = i === activeIdx ? ' active' : '';
    const kindClass = (item.kind || '').replace(/[^a-z-]/g, '');
    html +=
      '<div class="slash-picker-item' + activeClass + '" data-index="' + i + '" role="option" aria-selected="' + (i === activeIdx ? 'true' : 'false') + '">' +
        '<span class="name">' + highlightSlashMatch(item.name, state.slash.query) + '</span>' +
        '<span class="desc">' + escapeHtml(item.description || '') + '</span>' +
        '<span class="kind ' + escapeHtml(kindClass) + '">' + escapeHtml(item.kind || '') + '</span>' +
      '</div>';
  }
  slashPickerList.innerHTML = html;
  for (const row of slashPickerList.querySelectorAll('.slash-picker-item')) {
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const idx = parseInt(row.dataset.index, 10);
      if (!isNaN(idx)) insertSlashCommand(idx);
    });
  }
  const activeEl = slashPickerList.querySelector('.slash-picker-item.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

function openSlashPicker() {
  if (!slashPicker) return;
  slashPicker.hidden = false;
  state.slash.open = true;
  fetchSlashCommands();
}

function closeSlashPicker() {
  if (!slashPicker) return;
  slashPicker.hidden = true;
  state.slash.open = false;
  state.slash.query = '';
  state.slash.filtered = [];
  state.slash.activeIndex = 0;
}

function updateSlashPicker() {
  if (!liveTextarea) return;
  const val = liveTextarea.value;
  if (/^\/[^\s]*$/.test(val)) {
    state.slash.query = val;
    filterSlash(val);
    state.slash.activeIndex = 0;
    openSlashPicker();
    renderSlashList();
  } else {
    closeSlashPicker();
  }
}

function insertSlashCommand(index) {
  const item = state.slash.filtered[index];
  if (!item || !liveTextarea) return;
  liveTextarea.value = item.name + ' ';
  closeSlashPicker();
  liveTextarea.dispatchEvent(new Event('input'));
  liveTextarea.focus();
  const len = liveTextarea.value.length;
  liveTextarea.setSelectionRange(len, len);
}

document.addEventListener('click', (e) => {
  if (!state.slash.open) return;
  if (slashPicker && !slashPicker.contains(e.target) && e.target !== liveTextarea) {
    closeSlashPicker();
  }
});

if (liveSendBtn) {
  liveSendBtn.addEventListener('click', () => { sendLiveText(); });
}

// ─── Server-side lazy load earlier ───────────────────────────────────────────
function loadEarlier() {
  if (state.transcript.loading || !state.transcript.hasEarlier) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.transcript.loading = true;
  if (liveLoadEarlierBtn) liveLoadEarlierBtn.disabled = true;
  state.ws.send(JSON.stringify({
    type: 'load_earlier',
    before: state.transcript.oldestStartIdx,
    limit: 200
  }));
}

// Wire the load-earlier button and set up an IntersectionObserver so scrolling
// to the top automatically triggers the fetch (same UX as most chat apps).
if (liveLoadEarlierBtn) {
  liveLoadEarlierBtn.addEventListener('click', loadEarlier);

  const _loadEarlierObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) loadEarlier();
    }
  }, { root: chatMessages, threshold: 0 });
  _loadEarlierObserver.observe(liveLoadEarlierBtn);
}

// ─── Terminal preview (HITL surfacing) ───────────────────────────────────────
//
// Why this exists: the live tail only sees what claude writes to its jsonl —
// permission prompts, plan-mode menus and other HITL UI live in the TUI and
// never make it to disk. Fetching `tmux capture-pane` (or cmux surface.read_text)
// gives us a plain-text snapshot of the visible pane, which is enough for the
// user to see "Do you want to proceed? (y/n)" or the numbered plan menu and
// type the appropriate response into the input bar.

const TERMINAL_POLL_MS = 2000;

function setTerminalStatus(text) {
  if (liveTerminalStatus) liveTerminalStatus.textContent = text || '';
}

function applyPaneSnapshot(msg) {
  const errorText = msg && msg.error ? String(msg.error) : null;
  const snapText = msg && typeof msg.text === 'string' ? msg.text : '';

  // Always feed the TUI picker detector — this is the live "before user
  // answers" surface, since claude doesn't flush tool_use AskUserQuestion to
  // jsonl until the user answers in the TUI. We bypass jsonl entirely here.
  applyTuiPickerSnapshot(snapText, !!errorText);

  if (!liveTerminalPanel) { state.terminal.inflight = false; return; }
  if (errorText) {
    liveTerminalPanel.innerHTML = '';
    const empty = el('div', 'live-terminal-empty', escapeHtml(errorText));
    liveTerminalPanel.appendChild(empty);
    setTerminalStatus('오류');
    state.terminal.inflight = false;
    return;
  }
  const text = snapText;
  // tmux/cmux snapshots are wrapped to the pane width and often padded with
  // trailing whitespace. Trim trailing blank lines and right-trim each line so
  // the panel doesn't look full of empty rows.
  const lines = text.replace(/\s+$/, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  // Drop leading blank lines too.
  while (lines.length > 0 && lines[0] === '') lines.shift();
  const trimmed = lines.join('\n');
  liveTerminalPanel.textContent = trimmed || '(빈 화면)';
  state.terminal.lastUpdated = Date.now();
  state.terminal.lastSource = (msg && msg.source) || null;
  const stamp = new Date(state.terminal.lastUpdated).toLocaleTimeString();
  const src = state.terminal.lastSource ? ' · ' + state.terminal.lastSource : '';
  setTerminalStatus(stamp + src);
  state.terminal.inflight = false;
  // Keep scrolled to the bottom so the latest TUI line is visible.
  liveTerminalPanel.scrollTop = liveTerminalPanel.scrollHeight;
}

function refreshTerminalPreview() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  if (state.terminal.inflight) return;
  if (!isForwardingAvailable()) {
    setTerminalStatus('연결된 외부 세션 없음');
    return;
  }
  state.terminal.inflight = true;
  setTerminalStatus('갱신 중…');
  try {
    state.ws.send(JSON.stringify({ type: 'capture_pane' }));
  } catch (_) {
    state.terminal.inflight = false;
  }
}

function setTerminalOpen(open) {
  if (!liveTerminalPanel || !liveTerminalToggle) return;
  state.terminal.open = !!open;
  liveTerminalPanel.hidden = !state.terminal.open;
  liveTerminalToggle.classList.toggle('active', state.terminal.open);
  liveTerminalToggle.setAttribute('aria-pressed', state.terminal.open ? 'true' : 'false');
  if (liveTerminalRefresh) liveTerminalRefresh.hidden = !state.terminal.open;
  if (state.terminal.open) refreshTerminalPreview();
  else setTerminalStatus('');
}

// Capture-pane polling runs whenever forwarding is available, not gated on
// the terminal preview panel. The TUI picker detector consumes every snapshot
// to surface live AskUserQuestion-style pickers above the input bar.
function ensureCapturePolling() {
  if (state.terminal.pollTimer) return;
  if (!isForwardingAvailable()) return;
  refreshTerminalPreview();
  state.terminal.pollTimer = setInterval(refreshTerminalPreview, TERMINAL_POLL_MS);
}

function stopCapturePolling() {
  if (state.terminal.pollTimer) {
    clearInterval(state.terminal.pollTimer);
    state.terminal.pollTimer = null;
  }
}

// ─── TUI picker overlay (bypasses jsonl) ─────────────────────────────────────
//
// Claude Code doesn't flush a tool_use AskUserQuestion entry to jsonl until
// the turn completes (i.e., until the user answers). The live tail therefore
// can't show the picker while it's *pending*. To fix this we parse every
// capture-pane snapshot for a numbered-option picker and render it directly
// in an overlay above the input bar. Click sends "<N>+Enter" via tmux/cmux
// and lets the TUI advance naturally; the next snapshot detects the picker
// is gone and the overlay hides itself.
//
// Detection heuristic: a run of >= 2 sequentially-numbered "N. label" lines
// where at least one line carries a selection marker (❯, >, ▶ …). The
// question is the nearest non-empty line above the first option. Indented
// follow-up lines are folded into the previous option's description.

const TUI_NAV_HINT_RE = /^(↑|↓|→|←|\^|enter|esc|tab|space|backspace|return)\b/i;
const TUI_OPT_LINE_RE = /^(\s*)([❯>►▶▸▷✱◦●❱→]?)\s*(\d+)[.)]\s+(.+?)\s*$/u;
const TUI_MARKER_RE   = /[❯>►▶▸▷❱→]/;

function stripAnsiQuick(s) {
  return String(s || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

function detectTuiPicker(text) {
  if (!text) return null;
  const lines = stripAnsiQuick(text).split('\n').map((l) => l.replace(/\s+$/, ''));

  let bestRun = null;
  let runStart = -1;
  let runOpts = [];
  let runHl = -1;
  let runHasMarker = false;

  function commit() {
    if (runOpts.length >= 2 && runHasMarker) {
      // Last run wins — pickers always render near the cursor (bottom of pane).
      bestRun = { start: runStart, opts: runOpts.slice(), highlightedIdx: runHl };
    }
    runStart = -1; runOpts = []; runHl = -1; runHasMarker = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim()) { commit(); continue; }
    const m = ln.match(TUI_OPT_LINE_RE);
    if (m) {
      const num = parseInt(m[3], 10);
      const label = m[4].trim();
      const marker = m[2] && TUI_MARKER_RE.test(m[2]);
      const expected = runOpts.length + 1;
      if (num === expected) {
        if (runStart < 0) runStart = i;
        if (marker) { runHasMarker = true; runHl = runOpts.length; }
        runOpts.push({ label });
        continue;
      }
      if (num === 1) {
        commit();
        runStart = i;
        if (marker) { runHasMarker = true; runHl = 0; }
        runOpts.push({ label });
        continue;
      }
      // Non-sequential number — break.
      commit();
      continue;
    }
    // Indented continuation: fold as description of last opt.
    if (runOpts.length > 0 && /^\s{2,}\S/.test(ln) && !TUI_NAV_HINT_RE.test(ln.trim())) {
      const last = runOpts[runOpts.length - 1];
      const t = ln.trim();
      last.description = last.description ? last.description + ' ' + t : t;
      continue;
    }
    // Anything else ends the run.
    commit();
  }
  commit();

  if (!bestRun) return null;

  // Question: nearest non-empty non-nav-hint line above the first option.
  let question = '';
  for (let i = bestRun.start - 1; i >= Math.max(0, bestRun.start - 14); i--) {
    const t = lines[i].trim();
    if (!t) continue;
    if (TUI_NAV_HINT_RE.test(t)) continue;
    // Skip pure punctuation / decoration lines.
    if (/^[─━═\-=*•]+$/.test(t)) continue;
    question = t;
    break;
  }

  return {
    question: question || '외부 세션이 선택을 기다립니다',
    options: bestRun.opts.map((o) => ({ label: o.label, description: o.description || '' })),
    highlightedIdx: bestRun.highlightedIdx,
  };
}

function pickerSignature(p) {
  if (!p) return null;
  return p.question + '||' + p.options.map((o) => o.label).join('|');
}

function applyTuiPickerSnapshot(text, isError) {
  if (isError) { hideTuiPickerOverlay(); return; }
  const picker = detectTuiPicker(text);
  if (!picker) {
    if (state.tuiPicker.active) hideTuiPickerOverlay();
    return;
  }
  const sig = pickerSignature(picker);
  if (state.tuiPicker.signature === sig) {
    // Same picker still showing — just refresh highlight.
    if (!state.tuiPicker.pending) updateTuiPickerHighlight(picker.highlightedIdx);
    return;
  }
  state.tuiPicker.signature = sig;
  state.tuiPicker.active = true;
  state.tuiPicker.pending = false;
  state.tuiPicker.pendingIdx = -1;
  renderTuiPickerOverlay(picker);
}

function renderTuiPickerOverlay(picker) {
  if (!tuiPickerOverlay) return;
  const questions = [{
    question: picker.question,
    header: 'live',
    multiSelect: false,
    options: picker.options,
  }];
  // Seed local highlight from TUI's reported highlight (default 0 if none).
  state.tuiPicker.optionCount = picker.options.length;
  state.tuiPicker.localHl = picker.highlightedIdx >= 0 ? picker.highlightedIdx : 0;

  // Detect a free-form "Type something" / 입력 option so we can show a text
  // input alongside the buttons. AskUserQuestion adds this option implicitly;
  // we match case-insensitive English + Korean variants.
  state.tuiPicker.typeSomethingIdx = -1;
  picker.options.forEach((o, i) => {
    const lbl = String((o && o.label) || '').toLowerCase().trim();
    if (lbl === 'type something' || /^type\s/.test(lbl) || /^(직접 입력|타이핑|입력)/.test(o.label || '')) {
      state.tuiPicker.typeSomethingIdx = i;
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'tui-picker-cancel';
  cancelBtn.title = '답변 취소 (Esc)';
  cancelBtn.innerHTML = '<i data-lucide="x"></i><span>취소 (Esc)</span>';
  cancelBtn.addEventListener('click', cancelTuiPicker);

  const root = buildAskPicker(questions, {
    onPick: (qIdx, optIdx) => onTuiPickerClick(optIdx),
    highlightedIdx: state.tuiPicker.localHl,
  });

  tuiPickerOverlay.classList.remove('cancelling');
  tuiPickerOverlay.innerHTML = '';
  tuiPickerOverlay.appendChild(cancelBtn);
  tuiPickerOverlay.appendChild(root);

  // Free-form text input. Always shown — if there's a "Type something" option
  // we select it first then send the typed text; otherwise we just send the
  // text and Enter and let the TUI handle it.
  const inputRow = document.createElement('div');
  inputRow.className = 'tui-picker-input-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tui-picker-input';
  input.placeholder = state.tuiPicker.typeSomethingIdx >= 0
    ? '직접 입력 (Enter로 전송)'
    : '직접 입력 (Enter로 전송 — TUI가 free-form을 받지 않으면 무시될 수 있음)';
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'tui-picker-input-send';
  submit.innerHTML = '<i data-lucide="send"></i>';
  submit.title = '전송';
  const sendFreeForm = () => {
    const text = input.value.trim();
    if (!text) return;
    onTuiPickerFreeFormSubmit(text);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      sendFreeForm();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelTuiPicker();
    }
  });
  submit.addEventListener('click', sendFreeForm);
  inputRow.appendChild(input);
  inputRow.appendChild(submit);
  tuiPickerOverlay.appendChild(inputRow);

  tuiPickerOverlay.hidden = false;
  if (typeof renderIcons === 'function') renderIcons();

  // Move keyboard focus into the picker so the textarea stops consuming
  // arrow keys (browsers route arrow keys in a textarea to text-cursor nav,
  // which on some platforms can race past our document-level listener).
  // With a button focused, native key behavior is a no-op and our handler
  // owns the arrow/Enter routing.
  requestAnimationFrame(() => {
    const target = tuiPickerOverlay.querySelector('.ask-option.tui-highlighted')
                || tuiPickerOverlay.querySelector('.ask-option');
    if (target) {
      try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
    }
  });
}

// Submit a free-form typed answer. If a "Type something" option exists,
// select it first (so the TUI is ready for text input), then send the text
// with a small delay to let the TUI advance. Otherwise just send the text
// followed by Enter and let the TUI decide.
function onTuiPickerFreeFormSubmit(text) {
  if (!isForwardingAvailable() || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('외부 세션 연결이 없어 답변 전송 불가', 'error');
    return;
  }
  state.tuiPicker.pending = true;
  if (tuiPickerOverlay) {
    tuiPickerOverlay.querySelectorAll('.ask-option').forEach((b) => { b.disabled = true; });
    const inp = tuiPickerOverlay.querySelector('.tui-picker-input');
    if (inp) inp.disabled = true;
    const sbtn = tuiPickerOverlay.querySelector('.tui-picker-input-send');
    if (sbtn) sbtn.disabled = true;
  }
  const tsIdx = state.tuiPicker.typeSomethingIdx;
  if (tsIdx >= 0) {
    try { state.ws.send(JSON.stringify({ type: 'send', text: String(tsIdx + 1) + '\n' })); } catch (_) {}
    // Give the TUI a moment to advance into text-input mode before pushing
    // the actual text + Enter.
    setTimeout(() => {
      try { state.ws.send(JSON.stringify({ type: 'send', text: text + '\n' })); } catch (_) {}
    }, 350);
  } else {
    try { state.ws.send(JSON.stringify({ type: 'send', text: text + '\n' })); } catch (_) {}
  }
  setTimeout(refreshTerminalPreview, 600);
  setTimeout(refreshTerminalPreview, 1500);
}

function syncTuiPickerHighlight() {
  if (!tuiPickerOverlay || tuiPickerOverlay.hidden) return;
  const hl = state.tuiPicker.localHl;
  let target = null;
  tuiPickerOverlay.querySelectorAll('.ask-option').forEach((b, i) => {
    const isHl = i === hl;
    b.classList.toggle('tui-highlighted', isHl);
    if (isHl) target = b;
  });
  // Follow visual highlight with keyboard focus so Tab order matches and the
  // native browser highlight ring tracks the picker selection.
  if (target && document.activeElement !== target) {
    try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
  }
}

// Called when the same picker is still in the TUI but its highlight moved.
// We only follow the TUI's highlight if the user hasn't navigated locally
// (signalled by localHl matching what we last seeded).
function updateTuiPickerHighlight(newHlIdx) {
  if (!tuiPickerOverlay || tuiPickerOverlay.hidden) return;
  // Don't override user's local nav.
  // (We can't tell perfectly, so just always follow TUI for now — it matches
  //  the user's mental model when they pick via terminal directly.)
  if (newHlIdx >= 0) {
    state.tuiPicker.localHl = newHlIdx;
    syncTuiPickerHighlight();
  }
}

function hideTuiPickerOverlay() {
  if (!tuiPickerOverlay) return;
  // If focus was inside the overlay, restore it to the textarea so typing
  // continues to land in the input bar after the picker closes.
  const hadFocus = tuiPickerOverlay.contains(document.activeElement);
  state.tuiPicker.signature = null;
  state.tuiPicker.active = false;
  state.tuiPicker.pending = false;
  state.tuiPicker.pendingIdx = -1;
  state.tuiPicker.localHl = -1;
  state.tuiPicker.optionCount = 0;
  state.tuiPicker.typeSomethingIdx = -1;
  tuiPickerOverlay.hidden = true;
  // Strip any transient state classes left over from a cancel-in-progress so
  // the next render doesn't inherit the dimmed look.
  tuiPickerOverlay.classList.remove('cancelling');
  tuiPickerOverlay.innerHTML = '';
  if (hadFocus && liveTextarea && !liveTextarea.disabled) {
    try { liveTextarea.focus({ preventScroll: true }); } catch (_) { liveTextarea.focus(); }
  }
}

// Cancel the picker by forwarding Escape to the TUI. The TUI dismisses the
// picker, the next capture-pane poll detects it's gone, and the overlay hides
// itself. Reachable via Esc key or the cancel button in the overlay.
function cancelTuiPicker() {
  if (state.tuiPicker.pending) return;
  if (!isForwardingAvailable() || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    // Even if we can't forward, hide the overlay locally so user isn't stuck.
    hideTuiPickerOverlay();
    return;
  }
  state.tuiPicker.pending = true;
  if (tuiPickerOverlay) {
    tuiPickerOverlay.querySelectorAll('.ask-option').forEach((b) => { b.disabled = true; });
    tuiPickerOverlay.classList.add('cancelling');
  }
  try { state.ws.send(JSON.stringify({ type: 'send', key: 'escape' })); } catch (_) {}
  setTimeout(refreshTerminalPreview, 250);
  setTimeout(refreshTerminalPreview, 900);
}

// Keyboard navigation for the picker overlay.
// - ArrowUp/Down and Esc are hijacked ALWAYS when picker is active (even
//   when typing in the input bar), matching the slash-picker UX.
// - Enter, j/k, and 1-9 only apply when the focus isn't in a text field,
//   so typing in the input bar still sends messages and produces numeric
//   characters normally.
function stopAll(e) {
  e.preventDefault();
  e.stopPropagation();
  if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
}

document.addEventListener('keydown', (e) => {
  if (!state.tuiPicker.active) return;
  if (!tuiPickerOverlay || tuiPickerOverlay.hidden) return;
  const t = e.target;
  const inField = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
  const count = state.tuiPicker.optionCount;
  if (!count) return;

  let branch = 'fallthrough';

  if (e.key === 'Escape') {
    branch = 'esc';
    stopAll(e);
    cancelTuiPicker();
  } else if (state.tuiPicker.pending) {
    branch = 'pending-skip';
  } else if (e.key === 'ArrowDown') {
    branch = 'arrow-down';
    stopAll(e);
    state.tuiPicker.localHl = Math.min((state.tuiPicker.localHl < 0 ? -1 : state.tuiPicker.localHl) + 1, count - 1);
    syncTuiPickerHighlight();
  } else if (e.key === 'ArrowUp') {
    branch = 'arrow-up';
    stopAll(e);
    state.tuiPicker.localHl = Math.max((state.tuiPicker.localHl < 0 ? count : state.tuiPicker.localHl) - 1, 0);
    syncTuiPickerHighlight();
  } else if (inField) {
    branch = 'in-field-skip';
  } else if (e.key === 'Enter') {
    branch = 'enter-submit';
    stopAll(e);
    const idx = state.tuiPicker.localHl >= 0 ? state.tuiPicker.localHl : 0;
    onTuiPickerClick(idx);
  } else if (e.key === 'j') {
    branch = 'j-down';
    stopAll(e);
    state.tuiPicker.localHl = Math.min(state.tuiPicker.localHl + 1, count - 1);
    syncTuiPickerHighlight();
  } else if (e.key === 'k') {
    branch = 'k-up';
    stopAll(e);
    state.tuiPicker.localHl = Math.max(state.tuiPicker.localHl - 1, 0);
    syncTuiPickerHighlight();
  } else if (/^[1-9]$/.test(e.key)) {
    const idx = parseInt(e.key, 10) - 1;
    if (idx < count) {
      branch = 'digit-' + e.key;
      stopAll(e);
      state.tuiPicker.localHl = idx;
      syncTuiPickerHighlight();
      onTuiPickerClick(idx);
    } else {
      branch = 'digit-out-of-range';
    }
  }

  console.log('[wotm picker key]', e.key, 'branch=' + branch, 'inField=' + inField, 'localHl=' + state.tuiPicker.localHl, 'pending=' + state.tuiPicker.pending);
}, { capture: true });

function onTuiPickerClick(optIdx) {
  if (!isForwardingAvailable() || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('외부 세션 연결이 없어 답변 전송 불가', 'error');
    return;
  }
  state.tuiPicker.pending = true;
  state.tuiPicker.pendingIdx = optIdx;
  // Optimistic UI: mark chosen + disable all options.
  if (tuiPickerOverlay) {
    tuiPickerOverlay.querySelectorAll('.ask-option').forEach((b, i) => {
      b.disabled = true;
      if (i === optIdx) b.classList.add('sent');
    });
  }
  // Trailing \n is peeled into a separate Enter key by tmuxClient.
  const text = String(optIdx + 1) + '\n';
  try { state.ws.send(JSON.stringify({ type: 'send', text })); } catch (_) {}
  // Trigger faster refresh so the overlay disappears once the TUI advances.
  setTimeout(refreshTerminalPreview, 250);
  setTimeout(refreshTerminalPreview, 900);
}

if (liveTerminalToggle) {
  liveTerminalToggle.addEventListener('click', () => {
    setTerminalOpen(!state.terminal.open);
  });
}
if (liveTerminalRefresh) {
  liveTerminalRefresh.addEventListener('click', () => { refreshTerminalPreview(); });
}

// Pause capture-pane polling when the page goes to the background; resume on
// foreground. This applies regardless of terminal preview panel state because
// the picker detector also consumes snapshots.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCapturePolling();
  else ensureCapturePolling();
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
function openWS() {
  setConnState('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/ws/live');
  state.ws = ws;

  state._connectTimer = setTimeout(() => {
    console.warn('[chat-live] WS open timeout — closing');
    state._lastFailReason = 'connect_timeout';
    try { ws.close(); } catch (_) {}
  }, WS_CONNECT_TIMEOUT_MS);

  ws.addEventListener('open', () => {
    if (state._connectTimer) { clearTimeout(state._connectTimer); state._connectTimer = null; }
    state.reconnectAttempted = false;
    setConnState('connected');
    const hello = { type: 'hello' };
    if (state.sessionId) hello.sessionId = state.sessionId;
    else if (state.cwd) hello.cwd = state.cwd;
    ws.send(JSON.stringify(hello));
    state._initTimer = setTimeout(() => {
      console.warn('[chat-live] init timeout — closing');
      state._lastFailReason = 'init_timeout';
      try { ws.close(); } catch (_) {}
    }, WS_INIT_TIMEOUT_MS);
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    const type = msg.type;

    if (type === 'init') {
      if (state._initTimer) { clearTimeout(state._initTimer); state._initTimer = null; }
      state._lastFailReason = null;
      // Apply meta synchronously so the input bar / cmux status / connection
      // dot reflect reality immediately.
      applyMeta(msg.meta);
      // Update server-side pagination state.
      state.transcript.oldestStartIdx = msg.oldestStartIdx != null ? msg.oldestStartIdx : 0;
      state.transcript.hasEarlier = !!msg.hasEarlier;
      state.transcript.loading = false;
      if (liveLoadEarlierBtn) {
        liveLoadEarlierBtn.hidden = !state.transcript.hasEarlier;
        liveLoadEarlierBtn.disabled = false;
      }
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
    if (type === 'earlier_events') {
      const innerEl = getMessagesInner();
      const prevScrollHeight = chatMessages.scrollHeight;
      const prevScrollTop = chatMessages.scrollTop;

      // Render events into a fragment via the appendTargetOverride mechanism.
      const frag = document.createDocumentFragment();
      const prevTarget = appendTargetOverride;
      appendTargetOverride = frag;
      try {
        for (const ev of (msg.events || [])) renderEvent(ev);
      } finally {
        appendTargetOverride = prevTarget;
      }

      // Prepend fragment as first content child after the load-earlier button.
      const anchor = liveLoadEarlierBtn && liveLoadEarlierBtn.parentNode === innerEl
        ? liveLoadEarlierBtn.nextSibling
        : innerEl.firstChild;
      innerEl.insertBefore(frag, anchor);

      // Restore scroll position so existing content doesn't jump.
      const newScrollHeight = chatMessages.scrollHeight;
      chatMessages.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);

      // Update pagination state.
      state.transcript.oldestStartIdx = msg.oldestStartIdx != null ? msg.oldestStartIdx : 0;
      state.transcript.hasEarlier = !!msg.hasEarlier;
      state.transcript.loading = false;
      if (liveLoadEarlierBtn) {
        liveLoadEarlierBtn.hidden = !state.transcript.hasEarlier;
        liveLoadEarlierBtn.disabled = false;
      }

      renderIcons();
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
    if (type === 'pane_snapshot') {
      applyPaneSnapshot(msg);
      return;
    }
    if (type === 'closed') {
      // Server is closing the socket; the close event will follow.
      return;
    }
  });

  ws.addEventListener('close', () => {
    if (state._connectTimer) { clearTimeout(state._connectTimer); state._connectTimer = null; }
    if (state._initTimer)    { clearTimeout(state._initTimer);    state._initTimer = null; }
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
      if (disconnectBanner) {
        const bannerText = disconnectBanner.querySelector('span');
        if (bannerText) {
          if (state._lastFailReason === 'connect_timeout') {
            bannerText.textContent = '서버 연결이 지연되고 있습니다. 새로고침하세요.';
          } else if (state._lastFailReason === 'init_timeout') {
            bannerText.textContent = '응답이 너무 오래 걸립니다. 새로고침하세요.';
          }
          // else: keep the existing default text ("연결이 끊어졌습니다. 새로고침하세요.")
        }
      }
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

// iOS Safari BFCache: force reload on back-nav so the live tail re-attaches
// and any new agent/icon code is picked up.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});

// ─── Boot ────────────────────────────────────────────────────────────────────
{
  // Accept claude/codex UUIDs or hermes timestamped ids (YYYYMMDD_HHMMSS_<hex>).
  const validSid = state.sessionId && (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(state.sessionId)
    || /^[0-9]{8}_[0-9]{6}_[0-9a-f]{6,8}$/.test(state.sessionId)
  );
  const validCwd = state.cwd && state.cwd.charAt(0) === '/';
  if (!validSid && !validCwd) {
    showToast('잘못된 세션 ID 또는 경로입니다.', 'error');
  } else {
    openWS();
  }
}
