'use strict';

// ─── Initialise Lucide icons (first pass, before dynamic content) ────────────
lucide.createIcons();

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  busy: false,
  pinned: true,       // scroll-pinned to bottom
  hasMessages: false,
  reconnectAttempted: false,
  ws: null,
  connected: false,

  // Account info (populated by auth_status events)
  account: null,

  // Account swap flow
  swap: {
    open: false,
    phase: 'picker',   // 'picker'|'starting'|'awaiting_url_visit'|'verifying'|'done'|'failed'|'cancelled'
    mode: null,        // 'claudeai'|'console'
    url: null,
    output: '',        // accumulated auth_output text (capped at last 8KB)
    error: null,
    newStatus: null,   // populated on done
    pendingRetryText: null,  // from quota_exceeded
  },

  // Slash command picker
  slash: {
    open: false,
    query: '',
    items: [],      // all commands flattened
    filtered: [],   // current filtered+sorted list (top 30)
    activeIndex: 0,
    fetched: false,
  },

  // Session switcher
  switcher: {
    open: false,
    items: [],          // managed sessions (legacy /api/sessions array)
    localItems: [],     // localActive sessions (PR-E3)
    filtered: [],       // flat list of {kind:'managed'|'local', item} after filter
    query: '',
    activeIndex: 0,
    fetched: false,
    refetchTimer: null,
    previousFocus: null,
  },
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const chatMessages    = $('chatMessages');
const emptyState      = $('emptyState');
const busyIndicator   = $('busyIndicator');
const chatSendBtn     = $('chatSendBtn');
const chatTextarea    = $('chatTextarea');
const projectLabel    = $('projectNameLabel');
const menuBtn         = $('menuBtn');
const chatPopover     = $('chatPopover');
const popoverBackdrop = $('popoverBackdrop');
const newChatBtn      = $('newChatBtn');
const logoutBtn       = $('logoutBtn');
const terminalLink    = $('terminalLink');
const scrollBtn       = $('scrollBtn');
const chatToast       = $('chatToast');
const chatToastText   = $('chatToastText');
const disconnectBanner = $('disconnectBanner');
const refreshBtn      = $('refreshBtn');
const connDot         = $('connDot');

// Account chip
const accountChip        = $('accountChip');
const accountChipEmail   = $('accountChipEmail');
const accountChipPopover = $('accountChipPopover');
const acpEmail           = $('acpEmail');
const acpOrg             = $('acpOrg');
const acpSub             = $('acpSub');
const acpSwapBtn         = $('acpSwapBtn');

// Swap modal
const swapModalBackdrop = $('swapModalBackdrop');
const swapModal         = $('swapModal');
const swapModalBody     = $('swapModalBody');
const swapModalFooter   = $('swapModalFooter');
const swapModalClose    = $('swapModalClose');

// Slash picker
const slashPicker      = $('slashPicker');
const slashPickerList  = $('slashPickerList');
const slashPickerEmpty = $('slashPickerEmpty');
const chatInputBar     = $('chatInputBar');

// Session switcher
const projectSwitcherBtn      = $('projectSwitcherBtn');
const sessionSwitcher         = $('sessionSwitcher');
const sessionSwitcherBackdrop = $('sessionSwitcherBackdrop');
const sessionSwitcherClose    = $('sessionSwitcherClose');
const sessionSwitcherSearch   = $('sessionSwitcherSearch');
const sessionSwitcherList     = $('sessionSwitcherList');

// ─── Project name from URL ────────────────────────────────────────────────────
const projectName = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
projectLabel.textContent = projectName;
document.title = projectName + ' — Claude Web';
terminalLink.href = '/session/' + encodeURIComponent(projectName);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderIcons() {
  lucide.createIcons();
}

// ─── Markdown / DOMPurify one-time setup ─────────────────────────────────────
(function setupMarkdown() {
  if (typeof DOMPurify === 'undefined') return;
  DOMPurify.addHook('afterSanitizeAttributes', function (node) {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
})();

// ─── Language guesser for syntax highlighting ─────────────────────────────────
function guessLang(filename) {
  if (!filename) return null;
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript',
    py: 'python',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    json: 'json',
    md: 'markdown', markdown: 'markdown',
    css: 'css',
    html: 'html', htm: 'html',
    yml: 'yaml', yaml: 'yaml',
    go: 'go',
    rs: 'rust',
    java: 'java',
    sql: 'sql',
    rb: 'ruby',
    php: 'php',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
    swift: 'swift',
    kt: 'kotlin',
    xml: 'xml',
    toml: 'toml',
    ini: 'ini', cfg: 'ini',
    dockerfile: 'dockerfile',
  };
  return map[ext] || null;
}

// ─── ANSI strip helper ────────────────────────────────────────────────────────
function stripAnsi(s) {
  return String(s == null ? '' : s).replace(/\x1B\[[0-9;]*m/g, '');
}

// ─── Highlight code block ─────────────────────────────────────────────────────
function highlightCode(code, filename) {
  if (typeof hljs === 'undefined') return escapeHtml(code);
  try {
    const lang = guessLang(filename);
    if (lang) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch (_) {
    return escapeHtml(code);
  }
}

// ─── Build a diff view from old/new strings ───────────────────────────────────
function buildDiffHtml(oldStr, newStr, filename) {
  if (typeof Diff === 'undefined') {
    return '<pre class="diff-fallback">' + escapeHtml(newStr) + '</pre>';
  }
  try {
    const patch = Diff.createPatch(filename || 'file', oldStr || '', newStr || '', '', '');
    const lines = patch.split('\n').slice(4); // strip the 4 header lines
    const html = lines.map(function (l) {
      if (l.startsWith('+') && !l.startsWith('+++')) {
        return '<div class="diff-add">' + escapeHtml(l) + '</div>';
      }
      if (l.startsWith('-') && !l.startsWith('---')) {
        return '<div class="diff-del">' + escapeHtml(l) + '</div>';
      }
      if (l.startsWith('@@')) {
        return '<div class="diff-hunk">' + escapeHtml(l) + '</div>';
      }
      return '<div class="diff-ctx">' + escapeHtml(l) + '</div>';
    }).join('');
    return '<div class="diff-view">' + html + '</div>';
  } catch (_) {
    return '<pre>' + escapeHtml(newStr) + '</pre>';
  }
}

// ─── Extract text from tool_result content ────────────────────────────────────
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

// ─── Tool-use element map (toolUseId -> {card, bodyEl, name, input}) ─────────
const toolUseElements = new Map();

// ─── Basename helper ─────────────────────────────────────────────────────────
function basename(filepath) {
  if (!filepath) return '';
  return filepath.split('/').pop() || filepath;
}

// ─── Make a copy button for a <pre> block ────────────────────────────────────
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
    }).catch(function () {
      showToast('클립보드 복사 실패', 'error');
    });
  });
  preEl.style.position = 'relative';
  preEl.appendChild(btn);
  return btn;
}

// ─── Connection status dot ────────────────────────────────────────────────────
function setConnState(s) {
  if (connDot) connDot.dataset.state = s;
  state.connected = s === 'connected';
}

// ─── Toast ───────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, kind) {
  chatToastText.textContent = msg;
  chatToast.classList.remove('info');
  if (kind === 'info') chatToast.classList.add('info');
  chatToast.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    chatToast.classList.remove('visible');
  }, 5000);
}

// ─── Busy state ──────────────────────────────────────────────────────────────
function setBusy(busy) {
  state.busy = busy;
  if (busy) {
    busyIndicator.classList.add('visible');
    chatSendBtn.classList.add('stop-mode');
    chatSendBtn.setAttribute('aria-label', '중단');
    chatSendBtn.disabled = false;
    chatSendBtn.innerHTML = '<i data-lucide="square"></i>';
  } else {
    busyIndicator.classList.remove('visible');
    chatSendBtn.classList.remove('stop-mode');
    chatSendBtn.setAttribute('aria-label', '전송');
    chatSendBtn.innerHTML = '<i data-lucide="send"></i>';
    updateSendBtn();
  }
  renderIcons();
}

function updateSendBtn() {
  if (state.busy) return;
  const empty = !chatTextarea.value.trim();
  chatSendBtn.disabled = empty;
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
    scrollBtn.classList.remove('visible');
  }
}

chatMessages.addEventListener('scroll', () => {
  const near = isNearBottom();
  if (near) {
    state.pinned = true;
    scrollBtn.classList.remove('visible');
  } else {
    state.pinned = false;
    scrollBtn.classList.add('visible');
  }
}, { passive: true });

scrollBtn.addEventListener('click', () => {
  scrollToBottom(true);
});

// ─── Message rendering ───────────────────────────────────────────────────────

function getMessagesInner() {
  return chatMessages.querySelector('.chat-messages-inner');
}

function removeEmptyState() {
  const es = chatMessages.querySelector('.chat-empty');
  if (es && es.parentNode) {
    es.remove();
  }
  state.hasMessages = true;
}

function appendNode(node) {
  removeEmptyState();
  getMessagesInner().appendChild(node);
  if (state.pinned) {
    scrollToBottom(false);
  }
  renderIcons();
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

// ── User bubble ──
function renderUserBubble(text) {
  const row = el('div', 'msg-row user');
  const bubble = el('div', 'msg-bubble', escapeHtml(text));
  row.appendChild(bubble);
  appendNode(row);
}

// ── Assistant bubble with markdown rendering ──
function renderAssistantBubble(text) {
  const row = el('div', 'msg-row assistant');
  const bubble = el('div', 'msg-bubble md-content');

  // Remove plain pre-wrap — markdown handles whitespace
  bubble.style.whiteSpace = 'normal';

  try {
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      const rawHtml = marked.parse(text, { breaks: true, gfm: true });
      const clean = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
      bubble.innerHTML = clean;

      // Syntax-highlight all code blocks and add copy buttons
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
      // Fallback: plain text with line breaks
      bubble.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
    }
  } catch (_) {
    bubble.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
  }

  row.appendChild(bubble);
  appendNode(row);
}

// ── Small system note ──
function renderSystemNote(html) {
  const row = el('div', 'msg-row system-note');
  const note = el('div', 'msg-system', html);
  row.appendChild(note);
  appendNode(row);
}

// ── Collapsible card (generic fallback) ──
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
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleCard();
    }
  });

  const row = el('div', 'msg-row assistant');
  row.appendChild(card);
  appendNode(row);
}

// ─── Rich tool-card helpers ───────────────────────────────────────────────────

// Build a rich tool card DOM node (not appended yet)
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

// Build the waiting placeholder body
function waitingBodyHtml() {
  return '<div class="tool-waiting"><span class="spin"><i data-lucide="loader-2"></i></span><span class="tool-waiting-label">결과 대기 중…</span></div>';
}

// ─── Per-tool body renderers (input phase) ────────────────────────────────────

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

function bodyForGlob(input) {
  return '<div class="tool-body-glob">' + waitingBodyHtml() + '</div>';
}

function bodyForGrep(input) {
  return '<div class="tool-body-grep">' + waitingBodyHtml() + '</div>';
}

function bodyForTodoWrite(input) {
  const todos = input.todos || [];
  if (!todos.length) return waitingBodyHtml();
  const done = todos.filter(function (t) { return t.status === 'completed'; }).length;
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

// ─── renderToolUseCard ────────────────────────────────────────────────────────
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
      iconName = 'file-text';
      labelText = 'Read';
      const fp = input.file_path || '';
      pillText = basename(fp);
      const startLine = input.start_line || input.offset || null;
      const endLine = input.end_line || null;
      if (startLine != null) {
        pillText += ':' + startLine + (endLine ? '–' + endLine : '+');
      }
      bodyNodeOrHtml = bodyForRead(input);
      bodyClass = 'tool-body-read-wrap';
      break;
    }
    case 'Bash': {
      iconName = 'terminal';
      labelText = 'Bash';
      const cmd = (input.command || '').trim();
      pillText = cmd.slice(0, 60) + (cmd.length > 60 ? '…' : '');
      bodyNodeOrHtml = bodyForBash(input);
      bodyClass = 'tool-body-bash';
      break;
    }
    case 'Edit': {
      iconName = 'pencil';
      labelText = 'Edit';
      pillText = basename(input.file_path || '');
      bodyNodeOrHtml = bodyForEdit(input);
      bodyClass = 'tool-body-edit';
      break;
    }
    case 'Write': {
      iconName = 'file-plus';
      labelText = 'Write';
      pillText = basename(input.file_path || '');
      // Write body is a DOM node
      const writeNode = bodyForWrite(input);
      bodyNodeOrHtml = writeNode;
      bodyClass = 'tool-body-write';
      break;
    }
    case 'Glob': {
      iconName = 'search';
      labelText = 'Glob';
      pillText = input.pattern || input.glob || '';
      bodyNodeOrHtml = bodyForGlob(input);
      bodyClass = 'tool-body-glob';
      break;
    }
    case 'Grep': {
      iconName = 'search';
      labelText = 'Grep';
      pillText = input.pattern || input.query || input.regex || '';
      bodyNodeOrHtml = bodyForGrep(input);
      bodyClass = 'tool-body-grep';
      break;
    }
    case 'TodoWrite': {
      iconName = 'list-checks';
      labelText = 'Todos';
      const todos = input.todos || [];
      const doneCnt = todos.filter(function (t) { return t.status === 'completed'; }).length;
      pillText = doneCnt + '/' + todos.length;
      bodyNodeOrHtml = bodyForTodoWrite(input);
      bodyClass = 'tool-body-todo-wrap';
      break;
    }
    case 'Task': {
      iconName = 'bot';
      labelText = 'Task';
      pillText = input.subagent_type || input.agent || '';
      bodyNodeOrHtml = bodyForTask(input);
      bodyClass = 'tool-body-task-wrap';
      break;
    }
    case 'WebFetch': {
      iconName = 'link';
      labelText = 'WebFetch';
      const fetchUrl = input.url || '';
      pillText = fetchUrl.replace(/^https?:\/\//, '').slice(0, 40);
      bodyNodeOrHtml = bodyForWebFetch(input);
      bodyClass = 'tool-body-webfetch';
      break;
    }
    case 'WebSearch': {
      iconName = 'globe';
      labelText = 'WebSearch';
      pillText = (input.query || '').slice(0, 40);
      bodyNodeOrHtml = bodyForWebSearch(input);
      bodyClass = 'tool-body-websearch';
      break;
    }
    default: {
      // Generic fallback
      iconName = 'wrench';
      labelText = name;
      pillText = null;
      bodyNodeOrHtml = '<pre class="tool-json-pre">' + escapeHtml(JSON.stringify(input, null, 2)) + '</pre>';
      bodyClass = 'tool-body-generic';
      break;
    }
  }

  // Build the card
  const statusHtml = '<span class="tool-status spin"><i data-lucide="loader-2"></i></span>';
  const card = buildToolCard(iconName, labelText, pillText, statusHtml, '', false);
  const bodyEl = card.querySelector('.msg-card-body');
  bodyEl.className = 'msg-card-body tool-card-body ' + bodyClass;

  if (typeof bodyNodeOrHtml === 'string') {
    bodyEl.innerHTML = bodyNodeOrHtml;
  } else {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(bodyNodeOrHtml);
  }

  // Register in map for result pairing
  if (toolUseId) {
    toolUseElements.set(toolUseId, { card, bodyEl, name, input });
  }

  const row = el('div', 'msg-row assistant');
  row.appendChild(card);
  appendNode(row);
}

// ─── updateToolResultBody ────────────────────────────────────────────────────
function updateToolResultBody(evt) {
  const toolUseId = evt.toolUseId || null;
  const isError = evt.isError === true;
  const content = evt.content;
  const resultText = extractResultText(content);

  // Update status icon
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
    // Orphan result — render standalone card
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

  // Expand automatically on error so user sees it
  if (isError) {
    card.classList.add('expanded');
    const header = card.querySelector('.msg-card-header');
    if (header) {
      header.setAttribute('aria-expanded', 'true');
      const toggle = header.querySelector('.card-toggle');
      if (toggle) toggle.innerHTML = '<i data-lucide="chevron-up"></i>';
    }
  }

  // Render the result body based on tool kind
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
      // Split into stdout + possible error sections
      const isErr = isError;
      const preClass = isErr ? 'tool-bash-pre tool-bash-stderr' : 'tool-bash-pre';
      // Trim to 200 lines
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
      // Already rendered input content; just confirm or show error
      if (isError) {
        bodyEl.innerHTML += '<div class="tool-error-note">' + escapeHtml(resultText.slice(0, 200)) + '</div>';
      }
      break;
    }
    case 'Glob': {
      const lines = resultText.split('\n').filter(function (l) { return l.trim(); });
      const shown = lines.slice(0, 50);
      const hasMore = lines.length > 50;
      let listHtml = '<ul class="tool-glob-list">';
      shown.forEach(function (f) {
        listHtml += '<li class="tool-glob-item">' + escapeHtml(f) + '</li>';
      });
      listHtml += '</ul>';
      if (hasMore) listHtml += '<div class="tool-more-hint">+ ' + (lines.length - 50) + ' more</div>';
      bodyEl.innerHTML = '<div class="tool-body-glob">' + listHtml + '</div>';
      break;
    }
    case 'Grep': {
      const lines = resultText.split('\n').filter(function (l) { return l.trim(); });
      let listHtml = '<div class="tool-grep-list">';
      lines.forEach(function (line) {
        // format: path:linenum:content
        const firstColon = line.indexOf(':');
        const secondColon = firstColon >= 0 ? line.indexOf(':', firstColon + 1) : -1;
        let pathPart = '', linePart = '', contentPart = '';
        if (secondColon > firstColon && firstColon >= 0) {
          pathPart = line.slice(0, secondColon);
          contentPart = line.slice(secondColon + 1);
        } else {
          contentPart = line;
        }
        const hitText = pathPart || line;
        listHtml +=
          '<div class="grep-hit" role="button" tabindex="0" title="클릭하여 경로 복사">' +
            (pathPart ? '<span class="grep-path">' + escapeHtml(pathPart) + '</span> ' : '') +
            '<span class="grep-content">' + escapeHtml(contentPart.slice(0, 120)) + '</span>' +
          '</div>';
      });
      listHtml += '</div>';
      bodyEl.innerHTML = '<div class="tool-body-grep">' + listHtml + '</div>';
      // Wire click-to-copy on each hit
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
      // Already rendered as input; show confirmation or error
      if (isError) {
        bodyEl.innerHTML += '<div class="tool-error-note">' + escapeHtml(resultText.slice(0, 200)) + '</div>';
      }
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
      // Try to parse results as JSON list or plain text
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
        // Plain text fallback
        resultsHtml = '<pre class="tool-fetch-pre">' + escapeHtml(resultText.slice(0, 600)) + '</pre>';
      }
      bodyEl.innerHTML = '<div class="tool-body-websearch">' + resultsHtml + '</div>';
      break;
    }
    default: {
      // Generic
      newBodyHtml = '<pre class="tool-json-pre">' + escapeHtml(resultText.slice(0, 2000)) + '</pre>';
      bodyEl.innerHTML = newBodyHtml;
      break;
    }
  }

  // Remove from map once resolved
  toolUseElements.delete(toolUseId);
  renderIcons();
}

// ── Quota-exceeded card ──
function renderQuotaCard(evt) {
  removeEmptyState();

  const text = evt.text || '';
  const truncated = text.length > 200 ? text.slice(0, 200) + '…' : text;
  const hasMore = text.length > 200;
  const lastPromptText = evt.lastPromptText || '';

  const row = el('div', 'msg-row assistant');

  const card = document.createElement('div');
  card.className = 'quota-card';

  const headerHtml =
    '<div class="quota-card-header">' +
      '<i data-lucide="alert-triangle"></i>' +
      '<span>사용 한도 초과</span>' +
    '</div>';

  const bodyHtml =
    '<div class="quota-card-body">' +
      '<p class="quota-card-desc">Claude 사용 한도에 도달했습니다. 계정을 전환하거나 잠시 후 다시 시도해주세요.</p>' +
      '<div class="quota-card-text" id="quotaCardText_' + Date.now() + '">' +
        '<span class="quota-text-short">' + escapeHtml(truncated) + '</span>' +
        (hasMore
          ? '<button class="quota-text-toggle" aria-expanded="false">' +
              '<i data-lucide="chevron-down"></i> 전체 보기' +
            '</button>' +
            '<span class="quota-text-full" hidden>' + escapeHtml(text) + '</span>'
          : '') +
      '</div>' +
    '</div>';

  const actionsHtml =
    '<div class="quota-card-actions">' +
      '<button class="quota-swap-btn">' +
        '<i data-lucide="refresh-cw"></i> 계정 전환' +
      '</button>' +
      (lastPromptText
        ? '<button class="quota-retry-btn">' +
            '<i data-lucide="rotate-ccw"></i> 이 메시지로 재시도' +
          '</button>'
        : '') +
    '</div>';

  card.innerHTML = headerHtml + bodyHtml + actionsHtml;

  // Toggle full text
  const toggleBtn = card.querySelector('.quota-text-toggle');
  if (toggleBtn) {
    const fullSpan = card.querySelector('.quota-text-full');
    const shortSpan = card.querySelector('.quota-text-short');
    toggleBtn.addEventListener('click', () => {
      const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        fullSpan.hidden = true;
        shortSpan.hidden = false;
        toggleBtn.setAttribute('aria-expanded', 'false');
        toggleBtn.innerHTML = '<i data-lucide="chevron-down"></i> 전체 보기';
      } else {
        fullSpan.hidden = false;
        shortSpan.hidden = true;
        toggleBtn.setAttribute('aria-expanded', 'true');
        toggleBtn.innerHTML = '<i data-lucide="chevron-up"></i> 접기';
      }
      renderIcons();
    });
  }

  // Swap button
  const swapBtn = card.querySelector('.quota-swap-btn');
  swapBtn.addEventListener('click', () => {
    openSwapModal();
  });

  // Retry button
  const retryBtn = card.querySelector('.quota-retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      chatTextarea.value = lastPromptText;
      autoResize();
      updateSendBtn();
      chatTextarea.focus();
    });
  }

  row.appendChild(card);
  appendNode(row);
}

// ─── Event renderer ──────────────────────────────────────────────────────────
function renderEvent(evt) {
  const kind = evt.kind;

  if (kind === 'user_text') {
    renderUserBubble(evt.text || '');
    return;
  }

  if (kind === 'assistant_text') {
    renderAssistantBubble(evt.text || '');
    return;
  }

  if (kind === 'assistant_thinking') {
    removeEmptyState();
    const row = el('div', 'msg-row assistant');
    row.appendChild(el('div', 'msg-thinking', '(reasoning…)'));
    appendNode(row);
    return;
  }

  if (kind === 'init') {
    const sid = evt.sessionId ? evt.sessionId.slice(0, 8) : '—';
    renderSystemNote('세션 시작 (' + escapeHtml(sid) + ')');
    return;
  }

  if (kind === 'result') {
    const cost = evt.costUsd != null ? '$' + Number(evt.costUsd).toFixed(4) : '';
    const dur  = evt.durationMs != null ? evt.durationMs + 'ms' : '';
    const parts = [cost, dur].filter(Boolean).join(' · ');
    renderSystemNote('응답 완료' + (parts ? ' — ' + escapeHtml(parts) : ''));
    return;
  }

  if (kind === 'system_notification') {
    renderSystemNote(escapeHtml(evt.message || ''));
    return;
  }

  if (kind === 'tool_use') {
    renderToolUseCard(evt);
    return;
  }

  if (kind === 'tool_result') {
    updateToolResultBody(evt);
    return;
  }

  if (kind === 'rate_limit') {
    removeEmptyState();
    const wrapper = el('div', 'msg-row system-note');
    const pill = el('div', 'msg-rate-limit');
    pill.innerHTML =
      '<i data-lucide="clock"></i>' +
      '<span>rate limit info</span>' +
      '<div class="msg-rate-limit-detail">' +
        '<pre>' + escapeHtml(JSON.stringify(evt, null, 2)) + '</pre>' +
      '</div>';
    pill.addEventListener('click', () => {
      pill.classList.toggle('expanded');
      renderIcons();
    });
    wrapper.appendChild(pill);
    appendNode(wrapper);
    return;
  }

  if (kind === 'parse_error') {
    removeEmptyState();
    const row = el('div', 'msg-row system-note');
    const note = el('div', 'msg-system');
    note.style.color = 'var(--danger)';
    note.textContent = '파싱 오류';
    note.title = evt.message || '';
    row.appendChild(note);
    appendNode(row);
    return;
  }

  // ── Auth / swap events ──

  if (kind === 'auth_status') {
    state.account = {
      loggedIn: evt.loggedIn,
      email: evt.email || null,
      orgName: evt.orgName || null,
      subscriptionType: evt.subscriptionType || null,
      authMethod: evt.authMethod || null,
      apiProvider: evt.apiProvider || null,
    };
    refreshAccountChip();
    return;
  }

  if (kind === 'auth_swap_phase') {
    state.swap.phase = evt.phase;
    if (evt.mode) state.swap.mode = evt.mode;
    // Auto-open modal if a swap is actively progressing and modal is closed
    if (!state.swap.open && ['starting', 'awaiting_url_visit', 'verifying'].includes(evt.phase)) {
      openSwapModal();
    } else {
      renderSwapModal();
    }
    return;
  }

  if (kind === 'auth_url') {
    state.swap.url = evt.url;
    state.swap.mode = evt.mode || state.swap.mode;
    // Transition to awaiting_url_visit phase when we get the URL
    if (state.swap.phase === 'starting') {
      state.swap.phase = 'awaiting_url_visit';
    }
    renderSwapModal();
    return;
  }

  if (kind === 'auth_output') {
    const chunk = evt.data || '';
    state.swap.output += chunk;
    // Cap at last 8KB
    if (state.swap.output.length > 8192) {
      state.swap.output = state.swap.output.slice(-8192);
    }
    renderSwapModal();
    return;
  }

  if (kind === 'auth_done') {
    if (evt.success) {
      state.swap.phase = 'done';
      state.swap.newStatus = evt.status || null;
    } else {
      state.swap.phase = 'failed';
      state.swap.error = evt.error || '알 수 없는 오류';
    }
    renderSwapModal();
    return;
  }

  if (kind === 'quota_exceeded') {
    // Save the last prompt text for retry
    state.swap.pendingRetryText = evt.lastPromptText || null;
    renderQuotaCard(evt);
    return;
  }

  // Fallback: unknown / anything else → card with JSON body
  const label = kind || 'unknown';
  const json = JSON.stringify(evt, null, 2);
  renderCard('help-circle', label, '<pre>' + escapeHtml(json) + '</pre>', false);
}

// ─── Render history ───────────────────────────────────────────────────────────
function renderHistory(messages) {
  const inner = getMessagesInner();
  const existing = inner.querySelectorAll('.msg-row');
  existing.forEach((n) => n.remove());
  // Clear tool pairing map on history reload
  toolUseElements.clear();
  if (!messages || messages.length === 0) {
    if (!inner.querySelector('.chat-empty')) {
      const es = el('div', 'chat-empty');
      es.id = 'emptyState';
      es.innerHTML =
        '<i data-lucide="messages-square"></i>' +
        '<span>메시지를 입력해 시작</span>' +
        '<span class="chat-empty-hint">Enter 전송 · Shift+Enter 줄바꿈</span>';
      inner.appendChild(es);
      renderIcons();
    }
    state.hasMessages = false;
    return;
  }
  state.hasMessages = false;
  for (const evt of messages) {
    renderEvent(evt);
  }
  scrollToBottom(true);
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function openWS() {
  setConnState('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/ws/chat');
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.reconnectAttempted = false;
    setConnState('connected');
    ws.send(JSON.stringify({ type: 'hello', project: projectName }));
    // Request current auth status
    ws.send(JSON.stringify({ type: 'authStatus' }));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }

    const type = msg.type;

    if (type === 'history') {
      renderHistory(msg.messages || []);
      setBusy(msg.busy === true);
      return;
    }

    if (type === 'event') {
      // Live-update the session switcher when sessions change anywhere
      if (msg.kind === 'sessions_changed') {
        onSessionsChanged();
        return;
      }
      renderEvent(msg);
      return;
    }

    if (type === 'state') {
      setBusy(msg.busy === true);
      return;
    }

    if (type === 'error') {
      showToast(msg.message || '오류가 발생했습니다.', 'error');
      return;
    }

    if (type === 'closed') {
      return;
    }
  });

  ws.addEventListener('close', () => {
    state.ws = null;
    setConnState('disconnected');
    setBusy(false);
    if (!state.reconnectAttempted) {
      state.reconnectAttempted = true;
      setConnState('connecting');
      setTimeout(() => {
        try {
          openWS();
        } catch (_) {
          setConnState('disconnected');
          showDisconnectBanner();
        }
      }, 2000);
    } else {
      showDisconnectBanner();
    }
  });

  ws.addEventListener('error', () => {
    // onclose will fire right after; handled there
  });
}

function showDisconnectBanner() {
  disconnectBanner.style.display = 'flex';
  renderIcons();
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

refreshBtn.addEventListener('click', () => {
  location.reload();
});

// ─── Send message ─────────────────────────────────────────────────────────────
let isComposing = false;
chatTextarea.addEventListener('compositionstart', () => { isComposing = true; });
chatTextarea.addEventListener('compositionend',   () => { isComposing = false; });

function sendMessage() {
  const text = chatTextarea.value;
  if (!text.trim() || state.busy) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('연결이 끊어졌습니다.', 'error');
    return;
  }
  state.ws.send(JSON.stringify({ type: 'send', text }));
  chatTextarea.value = '';
  autoResize();
  updateSendBtn();
  scrollToBottom(true);
}

const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

chatTextarea.addEventListener('keydown', (e) => {
  // ── Slash picker keyboard handling (highest priority) ──
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
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !isComposing && !e.isComposing) {
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
    // Any other key: fall through to normal handling; picker updates on input event
  }

  // ── Normal handling ──
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (!state.busy) sendMessage();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !isComposing && !e.isComposing) {
    if (isTouchDevice) return;
    e.preventDefault();
    if (!state.busy) sendMessage();
    return;
  }
  if (e.key === 'Escape') {
    chatTextarea.blur();
    closePopover();
  }
});

chatTextarea.addEventListener('input', () => {
  autoResize();
  updateSendBtn();
  updateSlashPicker();
});

chatSendBtn.addEventListener('click', () => {
  if (state.busy) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'interrupt' }));
    }
  } else {
    sendMessage();
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    if (document.activeElement !== chatTextarea) {
      e.preventDefault();
      chatTextarea.focus();
      chatTextarea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
});

// ─── Auto-resize textarea ─────────────────────────────────────────────────────
function autoResize() {
  chatTextarea.style.height = 'auto';
  const maxH = parseInt(getComputedStyle(chatTextarea).maxHeight, 10);
  const scrollH = chatTextarea.scrollHeight;
  chatTextarea.style.height = Math.min(scrollH, maxH) + 'px';
}

// ─── Main menu popover ────────────────────────────────────────────────────────
function positionMenuPopover() {
  // Anchor below the menu button, right-aligned to its right edge.
  const r = menuBtn.getBoundingClientRect();
  chatPopover.style.top = (r.bottom + 6) + 'px';
  // Pin the popover's right edge to the button's right edge (clamp to 8px from viewport)
  const rightFromViewport = Math.max(8, window.innerWidth - r.right);
  chatPopover.style.right = rightFromViewport + 'px';
  chatPopover.style.left = 'auto';
}

function openPopover() {
  closeAccountChipPopover(); // Ensure only one popover is open at a time
  chatPopover.classList.add('open');
  popoverBackdrop.style.display = 'block';
  menuBtn.setAttribute('aria-expanded', 'true');
  positionMenuPopover();
}

function closePopover() {
  chatPopover.classList.remove('open');
  popoverBackdrop.style.display = 'none';
  menuBtn.setAttribute('aria-expanded', 'false');
  // Drop focus from the menu button so the focus ring doesn't linger
  if (document.activeElement === menuBtn) menuBtn.blur();
}

menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  chatPopover.classList.contains('open') ? closePopover() : openPopover();
});

window.addEventListener('resize', () => {
  if (chatPopover.classList.contains('open')) positionMenuPopover();
});

popoverBackdrop.addEventListener('click', () => {
  closePopover();
  closeAccountChipPopover();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closePopover();
    closeAccountChipPopover();
    if (state.switcher && state.switcher.open) {
      closeSwitcher();
    }
    // Only close swap modal on ESC if not in a blocking phase
    if (state.swap.open) {
      const blockingPhases = ['starting', 'verifying'];
      if (blockingPhases.includes(state.swap.phase)) {
        // Don't close — send cancel instead
        wsSend({ type: 'authSwapCancel' });
      } else {
        closeSwapModal();
      }
    }
  }
});

newChatBtn.addEventListener('click', () => {
  closePopover();
  if (state.busy) { showToast('응답 중에는 새 대화를 시작할 수 없습니다.', 'info'); return; }
  if (!confirm('현재 대화를 종료하고 새 대화를 시작하시겠습니까?')) return;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'newChat' }));
  }
});

logoutBtn.addEventListener('click', async () => {
  closePopover();
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  location.href = '/login';
});

// ─── Account chip ─────────────────────────────────────────────────────────────

function truncateEmail(email, maxLen) {
  if (!email) return '—';
  if (email.length <= maxLen) return email;
  const atIdx = email.indexOf('@');
  if (atIdx < 3) return email.slice(0, maxLen - 1) + '…';
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx);
  const keepLocal = Math.min(3, local.length);
  return local.slice(0, keepLocal) + '…' + domain;
}

function refreshAccountChip() {
  const acct = state.account;

  if (!acct || acct.loggedIn === false) {
    accountChip.classList.add('account-chip--warning');
    accountChipEmail.textContent = '로그인 필요';
    // Populate popover with minimal info
    if (acpEmail) acpEmail.textContent = '로그인되지 않음';
    if (acpOrg) acpOrg.textContent = '';
    if (acpSub) acpSub.textContent = '';
  } else {
    accountChip.classList.remove('account-chip--warning');
    const email = acct.email || '—';
    // On mobile the email span is hidden via CSS; on desktop show truncated
    accountChipEmail.textContent = truncateEmail(email, 22);

    if (acpEmail) acpEmail.textContent = email;
    if (acpOrg) acpOrg.textContent = acct.orgName || '';
    if (acpSub) {
      const parts = [];
      if (acct.subscriptionType) parts.push(acct.subscriptionType);
      if (acct.authMethod) parts.push(acct.authMethod);
      if (acct.apiProvider) parts.push(acct.apiProvider);
      acpSub.textContent = parts.join(' · ');
    }
  }
  renderIcons();
}

function openAccountChipPopover() {
  closePopover(); // Ensure menu popover is closed
  accountChipPopover.classList.add('open');
  accountChip.setAttribute('aria-expanded', 'true');
  // Position below the chip
  const chipRect = accountChip.getBoundingClientRect();
  accountChipPopover.style.top = (chipRect.bottom + 6) + 'px';
  accountChipPopover.style.left = chipRect.left + 'px';
}

function closeAccountChipPopover() {
  accountChipPopover.classList.remove('open');
  accountChip.setAttribute('aria-expanded', 'false');
}

accountChip.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!state.account || state.account.loggedIn === false) {
    // Open swap modal directly if not logged in
    openSwapModal();
    return;
  }
  if (accountChipPopover.classList.contains('open')) {
    closeAccountChipPopover();
  } else {
    openAccountChipPopover();
  }
});

accountChip.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    accountChip.click();
  }
});

if (acpSwapBtn) {
  acpSwapBtn.addEventListener('click', () => {
    closeAccountChipPopover();
    openSwapModal();
  });
}

// ─── Swap modal ───────────────────────────────────────────────────────────────

// Focus trap helpers
let _focusTrapElements = [];
let _focusTrapFirstEl = null;
let _focusTrapLastEl = null;
let _focusTrapHandler = null;

function installFocusTrap(container) {
  const focusable = container.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  _focusTrapElements = Array.from(focusable);
  _focusTrapFirstEl = _focusTrapElements[0] || null;
  _focusTrapLastEl = _focusTrapElements[_focusTrapElements.length - 1] || null;

  _focusTrapHandler = function(e) {
    if (e.key !== 'Tab') return;
    if (!_focusTrapFirstEl) return;
    if (e.shiftKey) {
      if (document.activeElement === _focusTrapFirstEl) {
        e.preventDefault();
        _focusTrapLastEl.focus();
      }
    } else {
      if (document.activeElement === _focusTrapLastEl) {
        e.preventDefault();
        _focusTrapFirstEl.focus();
      }
    }
  };
  container.addEventListener('keydown', _focusTrapHandler);
}

function removeFocusTrap(container) {
  if (_focusTrapHandler) {
    container.removeEventListener('keydown', _focusTrapHandler);
    _focusTrapHandler = null;
  }
}

function openSwapModal() {
  // Reset to picker if coming from a closed/done/failed state
  if (['done', 'failed', 'cancelled', 'picker'].includes(state.swap.phase)) {
    state.swap.phase = 'picker';
    state.swap.url = null;
    state.swap.output = '';
    state.swap.error = null;
    state.swap.newStatus = null;
  }
  state.swap.open = true;
  swapModal.removeAttribute('aria-hidden');
  swapModalBackdrop.removeAttribute('aria-hidden');
  swapModalBackdrop.style.display = 'block';
  swapModal.style.display = 'flex';
  document.body.classList.add('modal-open');
  renderSwapModal();
  requestAnimationFrame(() => {
    swapModal.classList.add('swap-modal--visible');
    swapModalBackdrop.classList.add('swap-modal-backdrop--visible');
    // Focus first focusable element
    const firstBtn = swapModal.querySelector('button:not([disabled])');
    if (firstBtn) firstBtn.focus();
    installFocusTrap(swapModal);
  });
}

function closeSwapModal() {
  state.swap.open = false;
  swapModal.setAttribute('aria-hidden', 'true');
  swapModalBackdrop.setAttribute('aria-hidden', 'true');
  swapModal.classList.remove('swap-modal--visible');
  swapModalBackdrop.classList.remove('swap-modal-backdrop--visible');
  document.body.classList.remove('modal-open');
  removeFocusTrap(swapModal);
  // Delay actual display:none so the fade-out transition completes
  setTimeout(() => {
    if (!state.swap.open) {
      swapModal.style.display = 'none';
      swapModalBackdrop.style.display = 'none';
    }
  }, 180);
}

swapModalClose.addEventListener('click', () => {
  const blockingPhases = ['starting', 'verifying'];
  if (blockingPhases.includes(state.swap.phase)) {
    wsSend({ type: 'authSwapCancel' });
  }
  closeSwapModal();
});

swapModalBackdrop.addEventListener('click', () => {
  const blockingPhases = ['starting', 'verifying'];
  if (blockingPhases.includes(state.swap.phase)) return; // Don't close while critical
  closeSwapModal();
});

// ── QR code helper ──
function renderQRCode(container, url) {
  // container is the element to render the canvas into
  container.innerHTML = '';
  try {
    QRCode.toCanvas(
      url,
      { width: 200, margin: 2, color: { dark: '#000000', light: '#FFFFFF' } },
      function (err, canvas) {
        if (err) {
          container.textContent = '(QR 생성 실패)';
          return;
        }
        canvas.style.borderRadius = '8px';
        container.appendChild(canvas);
      }
    );
  } catch (_) {
    container.textContent = '(QR 생성 실패)';
  }
}

// ── Copy to clipboard helper ──
function copyToClipboard(text, btn) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      const original = btn.innerHTML;
      btn.innerHTML = '<i data-lucide="check"></i> 복사됨';
      renderIcons();
      setTimeout(() => { btn.innerHTML = original; renderIcons(); }, 2000);
    }).catch(() => {
      showToast('클립보드 복사 실패', 'error');
    });
  } else {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
  }
}

// ── Main modal renderer ──
function renderSwapModal() {
  if (!swapModalBody || !swapModalFooter) return;
  const s = state.swap;
  const currentEmail = state.account && state.account.email ? state.account.email : '';

  switch (s.phase) {
    case 'picker':
      renderSwapPicker(currentEmail);
      break;
    case 'starting':
      renderSwapStarting();
      break;
    case 'awaiting_url_visit':
      renderSwapAwaitingCode();
      break;
    case 'verifying':
      renderSwapVerifying();
      break;
    case 'done':
      renderSwapDone();
      break;
    case 'failed':
      renderSwapFailed();
      break;
    case 'cancelled':
      renderSwapCancelled();
      break;
    default:
      renderSwapPicker(currentEmail);
  }
  renderIcons();
  // Re-install focus trap after DOM changes
  if (state.swap.open) {
    removeFocusTrap(swapModal);
    installFocusTrap(swapModal);
  }
}

function renderSwapPicker(currentEmail) {
  // Advanced options state: track whether email input is shown
  const showEmail = swapModal.dataset.showEmail === 'true';
  const savedEmail = swapModal.dataset.advEmail || currentEmail || '';

  swapModalBody.innerHTML =
    '<p class="swap-modal-desc">' +
      '현재 <strong>' + escapeHtml(currentEmail || '(미로그인)') + '</strong> 계정에서 로그아웃하고 다른 Anthropic 계정으로 전환합니다.' +
      '<br>진행 중인 응답이 있으면 먼저 완료해주세요.' +
    '</p>' +
    '<div class="swap-mode-grid">' +
      '<button class="swap-mode-btn" id="swapModeClaudai" aria-label="Claude.ai 구독 선택">' +
        '<i data-lucide="crown"></i>' +
        '<div class="swap-mode-label">Claude.ai 구독</div>' +
        '<div class="swap-mode-desc">월정액 구독 사용자</div>' +
      '</button>' +
      '<button class="swap-mode-btn" id="swapModeConsole" aria-label="Anthropic Console 선택">' +
        '<i data-lucide="key-round"></i>' +
        '<div class="swap-mode-label">Anthropic Console</div>' +
        '<div class="swap-mode-desc">API 종량제 사용자</div>' +
      '</button>' +
    '</div>' +
    '<div class="swap-advanced">' +
      '<button class="swap-advanced-toggle" id="swapAdvToggle">' +
        '<i data-lucide="' + (showEmail ? 'chevron-up' : 'chevron-down') + '"></i>' +
        ' 고급 옵션' +
      '</button>' +
      '<div class="swap-advanced-body" id="swapAdvBody" ' + (showEmail ? '' : 'hidden') + '>' +
        '<label class="swap-adv-label" for="swapEmailInput">인증 페이지에서 사전 입력할 이메일 (선택)</label>' +
        '<input type="text" id="swapEmailInput" class="swap-email-input" ' +
          'placeholder="user@example.com" ' +
          'autocomplete="email" autocorrect="off" autocapitalize="off" spellcheck="false" ' +
          'value="' + escapeHtml(savedEmail) + '">' +
      '</div>' +
    '</div>';

  swapModalFooter.innerHTML =
    '<button class="swap-cancel-btn" id="swapCancelBtn">취소</button>';

  // Wire buttons
  const advToggle = swapModal.querySelector('#swapAdvToggle');
  const advBody = swapModal.querySelector('#swapAdvBody');
  const emailInput = swapModal.querySelector('#swapEmailInput');

  advToggle.addEventListener('click', () => {
    const isHidden = advBody.hasAttribute('hidden');
    if (isHidden) {
      advBody.removeAttribute('hidden');
      swapModal.dataset.showEmail = 'true';
      advToggle.innerHTML = '<i data-lucide="chevron-up"></i> 고급 옵션';
    } else {
      advBody.setAttribute('hidden', '');
      swapModal.dataset.showEmail = 'false';
      advToggle.innerHTML = '<i data-lucide="chevron-down"></i> 고급 옵션';
    }
    renderIcons();
  });

  function startSwap(mode) {
    const email = emailInput ? emailInput.value.trim() : '';
    if (email) swapModal.dataset.advEmail = email;
    state.swap.mode = mode;
    state.swap.phase = 'starting';
    state.swap.output = '';
    state.swap.error = null;
    wsSend({ type: 'authSwapStart', mode, email: email || undefined });
    renderSwapModal();
  }

  swapModal.querySelector('#swapModeClaudai').addEventListener('click', () => startSwap('claudeai'));
  swapModal.querySelector('#swapModeConsole').addEventListener('click', () => startSwap('console'));
  swapModal.querySelector('#swapCancelBtn').addEventListener('click', () => closeSwapModal());
}

function renderSwapStarting() {
  swapModalBody.innerHTML =
    '<div class="swap-spinner-row">' +
      '<span class="spin"><i data-lucide="loader-2"></i></span>' +
      '<span>로그아웃 후 OAuth URL을 가져오는 중…</span>' +
    '</div>';

  swapModalFooter.innerHTML =
    '<button class="swap-cancel-btn" id="swapCancelBtn">취소</button>';

  swapModal.querySelector('#swapCancelBtn').addEventListener('click', () => {
    wsSend({ type: 'authSwapCancel' });
    closeSwapModal();
  });
}

function renderSwapAwaitingCode() {
  const url = state.swap.url || '';
  const outputLines = state.swap.output
    ? state.swap.output.split('\n').slice(-50).join('\n')
    : '';

  swapModalBody.innerHTML =
    '<p class="swap-url-label">다음 URL을 다른 기기 또는 새 탭에서 열어주세요.</p>' +

    '<div class="swap-qr-hint">이 QR을 다른 기기 카메라로 찍어 열기</div>' +
    '<div class="swap-qr-container" id="swapQrContainer"></div>' +

    '<div class="swap-url-row">' +
      '<div class="swap-url-display" id="swapUrlDisplay">' + escapeHtml(url) + '</div>' +
      '<button class="swap-url-copy" id="swapUrlCopy" aria-label="URL 복사">' +
        '<i data-lucide="copy"></i> URL 복사' +
      '</button>' +
    '</div>' +

    '<p class="swap-code-label">로그인 완료 후 redirect 페이지에서 표시되는 인증 코드를 아래에 붙여넣으세요.</p>' +
    '<input type="text" id="swapCodeInput" class="swap-code-input" ' +
      'placeholder="인증 코드 입력…" ' +
      'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ' +
      'inputmode="text" style="font-family: var(--mono); font-size: 16px;">' +

    '<details class="swap-pty-log" id="swapPtyDetails">' +
      '<summary>PTY 로그</summary>' +
      '<pre class="swap-pty-pre" id="swapPtyPre">' + escapeHtml(outputLines) + '</pre>' +
    '</details>';

  swapModalFooter.innerHTML =
    '<button class="swap-cancel-btn" id="swapCancelBtn">취소</button>' +
    '<button class="swap-submit-btn primary" id="swapSubmitBtn" disabled aria-label="인증 코드 제출">' +
      '<i data-lucide="arrow-right"></i> 제출' +
    '</button>';

  // Generate QR code
  if (url) {
    const qrContainer = swapModal.querySelector('#swapQrContainer');
    if (qrContainer) renderQRCode(qrContainer, url);
  }

  // Copy URL button
  const copyBtn = swapModal.querySelector('#swapUrlCopy');
  copyBtn.addEventListener('click', () => {
    copyToClipboard(url, copyBtn);
  });

  // Code input → enable submit
  const codeInput = swapModal.querySelector('#swapCodeInput');
  const submitBtn = swapModal.querySelector('#swapSubmitBtn');

  codeInput.addEventListener('input', () => {
    submitBtn.disabled = !codeInput.value.trim();
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && codeInput.value.trim()) {
      e.preventDefault();
      submitCode(codeInput.value.trim());
    }
  });

  submitBtn.addEventListener('click', () => {
    if (codeInput.value.trim()) submitCode(codeInput.value.trim());
  });

  swapModal.querySelector('#swapCancelBtn').addEventListener('click', () => {
    wsSend({ type: 'authSwapCancel' });
    closeSwapModal();
  });

  // Scroll PTY log to bottom
  const ptyPre = swapModal.querySelector('#swapPtyPre');
  if (ptyPre && state.swap.output) {
    setTimeout(() => { ptyPre.scrollTop = ptyPre.scrollHeight; }, 0);
  }
}

function submitCode(code) {
  state.swap.phase = 'verifying';
  wsSend({ type: 'authSwapCode', code });
  renderSwapModal();
}

function renderSwapVerifying() {
  swapModalBody.innerHTML =
    '<div class="swap-spinner-row">' +
      '<span class="spin"><i data-lucide="loader-2"></i></span>' +
      '<span>인증 코드 확인 중…</span>' +
    '</div>';

  swapModalFooter.innerHTML =
    '<button class="swap-cancel-btn" id="swapCancelBtn">취소</button>';

  swapModal.querySelector('#swapCancelBtn').addEventListener('click', () => {
    wsSend({ type: 'authSwapCancel' });
    closeSwapModal();
  });
}

function renderSwapDone() {
  const ns = state.swap.newStatus;
  const newEmail = ns && ns.email ? ns.email : (state.account && state.account.email ? state.account.email : '');
  const newOrg = ns && ns.orgName ? ns.orgName : '';
  const newSub = ns && ns.subscriptionType ? ns.subscriptionType : '';
  const hasPendingRetry = !!state.swap.pendingRetryText;

  swapModalBody.innerHTML =
    '<div class="swap-done-row">' +
      '<i data-lucide="check-circle-2" class="swap-done-icon"></i>' +
      '<div>' +
        '<div class="swap-done-title">계정 전환 완료</div>' +
        (newEmail ? '<div class="swap-done-email">' + escapeHtml(newEmail) + '</div>' : '') +
        (newOrg ? '<div class="swap-done-meta">' + escapeHtml(newOrg) + '</div>' : '') +
        (newSub ? '<div class="swap-done-meta">' + escapeHtml(newSub) + '</div>' : '') +
      '</div>' +
    '</div>' +
    (hasPendingRetry
      ? '<p class="swap-retry-hint">이전에 입력한 메시지를 재전송할 수 있습니다.</p>'
      : '');

  swapModalFooter.innerHTML =
    (hasPendingRetry
      ? '<button class="swap-resubmit-btn" id="swapResubmitBtn">' +
          '<i data-lucide="rotate-ccw"></i> 이전 메시지 재전송' +
        '</button>'
      : '') +
    '<button class="primary" id="swapDoneBtn">닫기</button>';

  swapModal.querySelector('#swapDoneBtn').addEventListener('click', () => {
    closeSwapModal();
    // Reset to picker for next time
    state.swap.phase = 'picker';
  });

  const resubmitBtn = swapModal.querySelector('#swapResubmitBtn');
  if (resubmitBtn) {
    resubmitBtn.addEventListener('click', () => {
      chatTextarea.value = state.swap.pendingRetryText || '';
      autoResize();
      updateSendBtn();
      chatTextarea.focus();
      state.swap.pendingRetryText = null;
      closeSwapModal();
      state.swap.phase = 'picker';
    });
  }
}

function renderSwapFailed() {
  const errMsg = state.swap.error || '알 수 없는 오류가 발생했습니다.';

  swapModalBody.innerHTML =
    '<div class="swap-error-row">' +
      '<i data-lucide="alert-circle" class="swap-error-icon"></i>' +
      '<div>' +
        '<div class="swap-error-title">전환 실패</div>' +
      '</div>' +
    '</div>' +
    '<pre class="swap-error-pre">' + escapeHtml(errMsg) + '</pre>';

  swapModalFooter.innerHTML =
    '<button class="swap-retry-again-btn" id="swapRetryAgainBtn">다시 시도</button>' +
    '<button class="swap-cancel-btn" id="swapCloseBtn">닫기</button>';

  swapModal.querySelector('#swapRetryAgainBtn').addEventListener('click', () => {
    state.swap.phase = 'picker';
    state.swap.error = null;
    state.swap.url = null;
    state.swap.output = '';
    renderSwapModal();
  });

  swapModal.querySelector('#swapCloseBtn').addEventListener('click', () => {
    closeSwapModal();
    state.swap.phase = 'picker';
  });
}

function renderSwapCancelled() {
  swapModalBody.innerHTML =
    '<div class="swap-cancelled-row">' +
      '<span class="swap-cancelled-note">전환이 취소되었습니다.</span>' +
    '</div>' +
    '<div class="swap-cancelled-warning">' +
      '<i data-lucide="alert-triangle"></i>' +
      '<span>주의: claude 계정에서 이미 로그아웃되었을 수 있습니다. ' +
      '다시 로그인하지 않으면 chat이 동작하지 않습니다.</span>' +
    '</div>';

  swapModalFooter.innerHTML =
    '<button class="swap-retry-again-btn" id="swapRetryAgainBtn">다시 시도</button>' +
    '<button class="swap-cancel-btn" id="swapCloseBtn">닫기</button>';

  swapModal.querySelector('#swapRetryAgainBtn').addEventListener('click', () => {
    state.swap.phase = 'picker';
    state.swap.url = null;
    state.swap.output = '';
    renderSwapModal();
  });

  swapModal.querySelector('#swapCloseBtn').addEventListener('click', () => {
    closeSwapModal();
    state.swap.phase = 'picker';
  });
}

// ─── Slash command picker ────────────────────────────────────────────────────

// Fetch commands once per page load
function fetchSlashCommands() {
  if (state.slash.fetched) return;
  state.slash.fetched = true; // mark immediately to avoid double-fetch

  fetch('/api/slash-commands', { credentials: 'same-origin' })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then((data) => {
      const kindOrder = { 'built-in': 0, plugin: 1, skill: 2, custom: 3, agent: 4 };
      const all = [
        ...(data.built_in || []),
        ...(data.plugins  || []),
        ...(data.skills   || []),
        ...(data.custom   || []),
        ...(data.agents   || []),
      ];
      // Dedupe by name
      const seen = new Set();
      state.slash.items = all.filter((item) => {
        if (seen.has(item.name)) return false;
        seen.add(item.name);
        return true;
      }).sort((a, b) => {
        const ko = (kindOrder[a.kind] || 99) - (kindOrder[b.kind] || 99);
        if (ko !== 0) return ko;
        return a.name.localeCompare(b.name);
      });
    })
    .catch(() => {
      // Silently fail — picker just shows nothing
    });
}

// Fuzzy match: every char of query appears in order in name (case-insensitive)
// Returns score (higher = better) or -1 if no match
function fuzzyScore(name, query) {
  if (!query) return 1; // empty query matches everything
  const haystack = name.toLowerCase();
  const needle = query.toLowerCase().replace(/^\//, ''); // ignore leading slash in query

  let hi = 0;
  let lastIdx = -1;
  let gaps = 0;
  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni];
    const found = haystack.indexOf(ch, hi);
    if (found === -1) return -1; // no match
    if (lastIdx !== -1) gaps += found - lastIdx - 1;
    lastIdx = found;
    hi = found + 1;
  }
  // Score: penalize gaps, reward matches at start
  const density = needle.length / haystack.length;
  const startBonus = haystack.startsWith(needle) ? 2 : (haystack.indexOf(needle) !== -1 ? 1 : 0);
  return density * 10 - gaps * 0.1 + startBonus;
}

// Highlight matched chars in name (returns HTML string)
function highlightMatch(name, query) {
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
    // chars before match
    if (found > hi) result.push(escapeHtml(name.slice(hi, found)));
    // matched char
    result.push('<mark>' + escapeHtml(name[found]) + '</mark>');
    hi = found + 1;
    ni++;
  }
  // remainder
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
    const kindClass = item.kind.replace(/[^a-z-]/g, '');
    html +=
      '<div class="slash-picker-item' + activeClass + '" data-index="' + i + '" role="option" aria-selected="' + (i === activeIdx ? 'true' : 'false') + '">' +
        '<span class="name">' + highlightMatch(item.name, state.slash.query) + '</span>' +
        '<span class="desc">' + escapeHtml(item.description || '') + '</span>' +
        '<span class="kind ' + escapeHtml(kindClass) + '">' + escapeHtml(item.kind) + '</span>' +
      '</div>';
  }
  slashPickerList.innerHTML = html;

  // Wire click handlers
  for (const row of slashPickerList.querySelectorAll('.slash-picker-item')) {
    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent textarea blur
      const idx = parseInt(row.dataset.index, 10);
      if (!isNaN(idx)) insertSlashCommand(idx);
    });
  }

  // Scroll active item into view
  const activeEl = slashPickerList.querySelector('.slash-picker-item.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

function openSlashPicker() {
  slashPicker.hidden = false;
  state.slash.open = true;
}

function closeSlashPicker() {
  slashPicker.hidden = true;
  state.slash.open = false;
  state.slash.query = '';
  state.slash.filtered = [];
  state.slash.activeIndex = 0;
}

function updateSlashPicker() {
  const val = chatTextarea.value;

  // Only show when the whole value is a single slash-command token (no spaces after slash)
  if (/^\/[^\s]*$/.test(val)) {
    const query = val; // e.g. "/he" or "/"
    state.slash.query = query;
    filterSlash(query);
    state.slash.activeIndex = 0;
    openSlashPicker();
    renderSlashList();
  } else {
    closeSlashPicker();
  }
}

function insertSlashCommand(index) {
  const item = state.slash.filtered[index];
  if (!item) return;
  chatTextarea.value = item.name + ' ';
  closeSlashPicker();
  // Trigger resize and send-button update
  chatTextarea.dispatchEvent(new Event('input'));
  chatTextarea.focus();
  // Move caret to end
  const len = chatTextarea.value.length;
  chatTextarea.setSelectionRange(len, len);
}

// Close picker on outside click
document.addEventListener('click', (e) => {
  if (!state.slash.open) return;
  if (!slashPicker.contains(e.target) && e.target !== chatTextarea) {
    closeSlashPicker();
  }
});

// Lazy fetch on first textarea focus
chatTextarea.addEventListener('focus', () => {
  fetchSlashCommands();
}, { once: true });

// ─── iOS / mobile keyboard handling ──────────────────────────────────────────
if (window.visualViewport) {
  let ticking = false;
  function onViewportResize() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const vv = window.visualViewport;
      const layoutH = window.innerHeight;
      const vvBottom = layoutH - (vv.offsetTop + vv.height);
      if (vvBottom > 50) {
        document.querySelector('.chat-page').style.paddingBottom = vvBottom + 'px';
      } else {
        document.querySelector('.chat-page').style.paddingBottom = '';
      }
    });
  }
  window.visualViewport.addEventListener('resize', onViewportResize);
  window.visualViewport.addEventListener('scroll', onViewportResize);
}

// ─── Session switcher ────────────────────────────────────────────────────────

const switcherDesktopMQ = window.matchMedia('(min-width: 720px)');

function isSwitcherDesktop() {
  return switcherDesktopMQ.matches;
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

function _switcherSnippet(item) {
  const t = item.lastUserText || item.lastAssistantText;
  return t ? t.trim() : '';
}

function _switcherDotState(item) {
  if (item.busy) return 'busy';
  if (item.sessionId) return 'idle';
  return 'inactive';
}

function _switcherFuzzyScore(name, query) {
  if (!query) return 1;
  const haystack = name.toLowerCase();
  const needle = query.toLowerCase();
  let hi = 0, lastIdx = -1, gaps = 0;
  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni];
    if (ch === ' ') continue;
    const found = haystack.indexOf(ch, hi);
    if (found === -1) return -1;
    if (lastIdx !== -1) gaps += found - lastIdx - 1;
    lastIdx = found;
    hi = found + 1;
  }
  const density = needle.length / Math.max(haystack.length, 1);
  const startBonus = haystack.startsWith(needle) ? 2 : (haystack.indexOf(needle) !== -1 ? 1 : 0);
  return density * 10 - gaps * 0.1 + startBonus;
}

function _switcherLocalTitle(it) {
  if (it && it.cwd) {
    const parts = String(it.cwd).split('/').filter(Boolean);
    return parts[parts.length - 1] || it.cwd;
  }
  return (it && it.sessionId) ? it.sessionId.slice(0, 8) : '—';
}

// Build a flat filtered list of {group, kind, item} where group ∈ 'recent'|'local'|'all'
function filterSwitcher(query) {
  const managed = state.switcher.items;
  const local = state.switcher.localItems;
  const recent = managed.filter((i) => i.hasMessages === true);
  const all = managed.filter((i) => i.hasMessages === false)
    .slice().sort((a, b) => a.name.localeCompare(b.name));
  const localSorted = local.slice().sort((a, b) => {
    if (a.busy !== b.busy) return a.busy ? -1 : 1;
    const ta = a.lastActivityTs ? Date.parse(a.lastActivityTs) : -Infinity;
    const tb = b.lastActivityTs ? Date.parse(b.lastActivityTs) : -Infinity;
    return tb - ta;
  });

  function scoreManaged(it) {
    if (!query) return 1;
    return _switcherFuzzyScore(it.name, query);
  }
  function scoreLocal(it) {
    if (!query) return 1;
    const title = _switcherLocalTitle(it);
    return _switcherFuzzyScore(title, query);
  }

  const out = [];
  function pushGroup(label, group, items, kind, scoreFn) {
    const matched = [];
    for (const it of items) {
      const s = scoreFn(it);
      if (s >= 0) matched.push({ it, s });
    }
    if (query) matched.sort((a, b) => b.s - a.s);
    if (!matched.length) return;
    out.push({ groupHeader: label, group });
    for (const { it } of matched) out.push({ kind, item: it, group });
  }

  pushGroup('최근 대화', 'recent', recent, 'managed', scoreManaged);
  pushGroup('로컬 세션', 'local', localSorted, 'local', scoreLocal);
  pushGroup('모든 프로젝트', 'all', all, 'managed', scoreManaged);

  state.switcher.filtered = out;
}

// Indices that are selectable (skip group headers)
function _switcherSelectableIndices() {
  const idxs = [];
  const arr = state.switcher.filtered;
  for (let i = 0; i < arr.length; i++) {
    if (!arr[i].groupHeader) idxs.push(i);
  }
  return idxs;
}

function _switcherClampActive() {
  const sel = _switcherSelectableIndices();
  if (!sel.length) { state.switcher.activeIndex = 0; return; }
  // If pointing at a header or out of range, snap to nearest selectable.
  const cur = state.switcher.activeIndex;
  if (sel.includes(cur)) return;
  // Find nearest
  let best = sel[0];
  let bestDist = Math.abs(sel[0] - cur);
  for (const s of sel) {
    const d = Math.abs(s - cur);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  state.switcher.activeIndex = best;
}

function renderSwitcherList() {
  const arr = state.switcher.filtered;
  const hasAnyData = state.switcher.items.length || state.switcher.localItems.length;
  const hasMatches = arr.some((e) => !e.groupHeader);
  if (!arr.length || !hasMatches) {
    sessionSwitcherList.innerHTML =
      '<div class="session-switcher-empty">' +
      (!hasAnyData ? '세션 목록을 불러올 수 없습니다.' : '일치하는 프로젝트가 없습니다.') +
      '</div>';
    return;
  }

  _switcherClampActive();
  const activeIdx = state.switcher.activeIndex;
  const html = [];
  for (let i = 0; i < arr.length; i++) {
    const entry = arr[i];
    if (entry.groupHeader) {
      html.push('<div class="session-switcher-group-header">' + escapeHtml(entry.groupHeader) + '</div>');
      continue;
    }
    const it = entry.item;
    const isLocal = entry.kind === 'local';
    const isActive = i === activeIdx;

    if (isLocal) {
      const sid = it.sessionId || '';
      const sidShort = sid.slice(0, 8);
      const title = _switcherLocalTitle(it);
      const snip = (it.lastUserText || it.lastAssistantText || '').trim();
      const hasSnip = !!snip;
      const time = formatRelativeTime(it.lastActivityTs);
      let ds = 'inactive';
      if (it.busy) ds = 'busy';
      else if (sid) ds = 'idle';
      const classes = ['session-row', 'local-row'];
      if (hasSnip) classes.push('with-snippet');
      if (it.busy) classes.push('busy');
      const sourceTxt = it.source || '';
      const pidTxt = it.pid != null ? String(it.pid) : '';
      html.push(
        '<a class="' + classes.join(' ') + '" ' +
          'href="/chat-live/' + encodeURIComponent(sid) + '" ' +
          'data-sid="' + escapeHtml(sid) + '" ' +
          'data-kind="local" ' +
          'data-index="' + i + '" ' +
          'title="' + escapeHtml(it.cwd || '') + '" ' +
          'role="option" ' +
          'aria-selected="' + (isActive ? 'true' : 'false') + '">' +
          '<span class="session-row-dot" data-state="' + ds + '" aria-hidden="true"></span>' +
          '<div class="session-row-main">' +
            '<div class="session-row-title-line">' +
              '<span class="session-row-title">' + escapeHtml(title) + '</span>' +
              (sourceTxt ? '<span class="local-source-badge">' + escapeHtml(sourceTxt) + '</span>' : '') +
              (pidTxt ? '<span class="local-pid-badge">PID ' + escapeHtml(pidTxt) + '</span>' : '') +
            '</div>' +
            (hasSnip
              ? '<div class="session-row-snippet">' + escapeHtml('"' + snip + '"') + '</div>'
              : (sidShort ? '<div class="session-row-snippet local-sid-line">' + escapeHtml(sidShort) + '…</div>' : '')) +
          '</div>' +
          (time
            ? '<time class="session-row-time" datetime="' + escapeHtml(it.lastActivityTs || '') + '">' + escapeHtml(time) + '</time>'
            : '') +
        '</a>'
      );
    } else {
      const snip = _switcherSnippet(it);
      const hasSnip = !!snip;
      const time = formatRelativeTime(it.lastUsedAt);
      const ds = _switcherDotState(it);
      const isCurrent = it.name === projectName;
      const classes = ['session-row'];
      if (hasSnip) classes.push('with-snippet');
      if (it.busy) classes.push('busy');
      if (isCurrent) classes.push('active');

      html.push(
        '<a class="' + classes.join(' ') + '" ' +
          'href="/chat/' + encodeURIComponent(it.name) + '" ' +
          'data-name="' + escapeHtml(it.name) + '" ' +
          'data-kind="managed" ' +
          'data-index="' + i + '" ' +
          'role="option" ' +
          'aria-selected="' + (isActive ? 'true' : 'false') + '">' +
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
  }
  sessionSwitcherList.innerHTML = html.join('');

  // Wire click handlers
  for (const row of sessionSwitcherList.querySelectorAll('.session-row')) {
    row.addEventListener('click', (e) => {
      e.preventDefault();
      const kind = row.dataset.kind;
      if (kind === 'local') {
        const sid = row.dataset.sid;
        if (sid) location.href = '/chat-live/' + encodeURIComponent(sid);
      } else {
        const name = row.dataset.name;
        if (name) location.href = '/chat/' + encodeURIComponent(name);
      }
    });
  }

  // Scroll active into view
  const activeEl = sessionSwitcherList.querySelector('.session-row[aria-selected="true"]');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

function positionSwitcher() {
  if (!isSwitcherDesktop()) return;
  // Anchor under the switcher button, left-aligned to its left edge.
  const r = projectSwitcherBtn.getBoundingClientRect();
  sessionSwitcher.style.top = (r.bottom + 6) + 'px';
  // Clamp to viewport (8px gutter) using width 360
  const desiredLeft = r.left;
  const maxLeft = window.innerWidth - 360 - 8;
  sessionSwitcher.style.left = Math.max(8, Math.min(desiredLeft, maxLeft)) + 'px';
  sessionSwitcher.style.right = 'auto';
}

async function fetchSwitcherSessions() {
  try {
    const r = await fetch('/api/sessions?include=local', { credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/login'; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const payload = await r.json();
    if (Array.isArray(payload)) {
      state.switcher.items = payload;
      state.switcher.localItems = [];
    } else {
      state.switcher.items = Array.isArray(payload.managed) ? payload.managed : [];
      state.switcher.localItems = Array.isArray(payload.localActive) ? payload.localActive : [];
    }
    state.switcher.fetched = true;
    filterSwitcher(state.switcher.query);
    // Default-select the current managed row if present, else first selectable.
    let idx = -1;
    const arr = state.switcher.filtered;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].kind === 'managed' && arr[i].item && arr[i].item.name === projectName) {
        idx = i; break;
      }
    }
    if (idx < 0) {
      const sel = _switcherSelectableIndices();
      idx = sel.length ? sel[0] : 0;
    }
    state.switcher.activeIndex = idx;
    renderSwitcherList();
  } catch (_) {
    state.switcher.items = [];
    state.switcher.localItems = [];
    state.switcher.filtered = [];
    renderSwitcherList();
  }
}

function onSessionsChanged() {
  if (state.switcher.open) {
    if (state.switcher.refetchTimer) clearTimeout(state.switcher.refetchTimer);
    state.switcher.refetchTimer = setTimeout(() => {
      state.switcher.refetchTimer = null;
      fetchSwitcherSessions();
    }, 300);
  } else {
    state.switcher.fetched = false;
  }
}

function openSwitcher() {
  if (state.switcher.open) return;
  // Close other surfaces first
  closePopover();
  closeAccountChipPopover();

  state.switcher.open = true;
  state.switcher.previousFocus = document.activeElement;
  state.switcher.query = '';
  if (sessionSwitcherSearch) sessionSwitcherSearch.value = '';

  sessionSwitcher.removeAttribute('hidden');
  sessionSwitcherBackdrop.removeAttribute('hidden');
  projectSwitcherBtn.setAttribute('aria-expanded', 'true');

  if (isSwitcherDesktop()) {
    positionSwitcher();
  }

  // Animate in
  requestAnimationFrame(() => {
    sessionSwitcher.classList.add('open');
    sessionSwitcherBackdrop.classList.add('open');
    // Focus search after the panel paints
    setTimeout(() => {
      if (sessionSwitcherSearch) sessionSwitcherSearch.focus();
    }, 60);
  });

  installFocusTrap(sessionSwitcher);

  // Render current items immediately if cached
  if (state.switcher.fetched && (state.switcher.items.length || state.switcher.localItems.length)) {
    filterSwitcher('');
    let idx = -1;
    const arr = state.switcher.filtered;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].kind === 'managed' && arr[i].item && arr[i].item.name === projectName) {
        idx = i; break;
      }
    }
    if (idx < 0) {
      const sel = _switcherSelectableIndices();
      idx = sel.length ? sel[0] : 0;
    }
    state.switcher.activeIndex = idx;
    renderSwitcherList();
  } else {
    sessionSwitcherList.innerHTML = '<div class="session-switcher-empty">불러오는 중…</div>';
  }
  // Always refetch on open to be fresh (cheap, no blocking)
  fetchSwitcherSessions();
  if (window.lucide) lucide.createIcons();
}

function closeSwitcher() {
  if (!state.switcher.open) return;
  state.switcher.open = false;
  sessionSwitcher.classList.remove('open');
  sessionSwitcherBackdrop.classList.remove('open');
  projectSwitcherBtn.setAttribute('aria-expanded', 'false');
  removeFocusTrap(sessionSwitcher);

  // Hide after transition completes
  setTimeout(() => {
    if (!state.switcher.open) {
      sessionSwitcher.setAttribute('hidden', '');
      sessionSwitcherBackdrop.setAttribute('hidden', '');
    }
  }, 220);

  // Restore focus to trigger
  const prev = state.switcher.previousFocus;
  if (prev && typeof prev.focus === 'function') {
    try { prev.focus(); } catch (_) {}
  } else {
    try { projectSwitcherBtn.focus(); } catch (_) {}
  }
  state.switcher.previousFocus = null;
}

// Trigger button
projectSwitcherBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (state.switcher.open) closeSwitcher(); else openSwitcher();
});

// Close button (mobile)
sessionSwitcherClose.addEventListener('click', () => closeSwitcher());

// Backdrop click closes
sessionSwitcherBackdrop.addEventListener('click', () => closeSwitcher());

// Search
sessionSwitcherSearch.addEventListener('input', () => {
  state.switcher.query = sessionSwitcherSearch.value || '';
  filterSwitcher(state.switcher.query);
  state.switcher.activeIndex = 0;
  renderSwitcherList();
});

// Keyboard nav inside the switcher
sessionSwitcher.addEventListener('keydown', (e) => {
  if (!state.switcher.open) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeSwitcher();
    return;
  }

  const items = state.switcher.filtered;
  if (!items.length) return;
  const sel = _switcherSelectableIndices();
  if (!sel.length) return;

  function moveTo(targetIdx) {
    state.switcher.activeIndex = targetIdx;
    renderSwitcherList();
  }
  function nextSelectable(from, dir) {
    // Find next selectable in direction; clamp at ends.
    const cur = sel.indexOf(from);
    if (cur === -1) {
      // Snap to nearest in direction
      for (let i = 0; i < sel.length; i++) {
        if (dir > 0 && sel[i] > from) return sel[i];
        if (dir < 0 && sel[sel.length - 1 - i] < from) return sel[sel.length - 1 - i];
      }
      return sel[dir > 0 ? 0 : sel.length - 1];
    }
    const ni = Math.min(Math.max(cur + dir, 0), sel.length - 1);
    return sel[ni];
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveTo(nextSelectable(state.switcher.activeIndex, 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveTo(nextSelectable(state.switcher.activeIndex, -1));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const entry = items[state.switcher.activeIndex];
    if (entry && !entry.groupHeader) {
      if (entry.kind === 'local') {
        const sid = entry.item && entry.item.sessionId;
        if (sid) location.href = '/chat-live/' + encodeURIComponent(sid);
      } else if (entry.kind === 'managed') {
        location.href = '/chat/' + encodeURIComponent(entry.item.name);
      }
    }
  } else if (e.key === 'Home') {
    e.preventDefault();
    moveTo(sel[0]);
  } else if (e.key === 'End') {
    e.preventDefault();
    moveTo(sel[sel.length - 1]);
  }
});

// Cmd/Ctrl+P opens the switcher (overrides browser print)
document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  if (e.key !== 'p' && e.key !== 'P') return;
  // Don't hijack while swap modal is open or slash picker is active
  if (state.swap.open) return;
  if (state.slash.open) return;
  e.preventDefault();
  if (state.switcher.open) closeSwitcher(); else openSwitcher();
});

// Reposition on resize / mode change
window.addEventListener('resize', () => {
  if (state.switcher.open && isSwitcherDesktop()) positionSwitcher();
});
switcherDesktopMQ.addEventListener('change', () => {
  if (state.switcher.open && isSwitcherDesktop()) positionSwitcher();
});

// ─── Boot ────────────────────────────────────────────────────────────────────
openWS();
