'use strict';
(function () {
  const PATHS = {
    claude: '/static/icons/anthropic.svg',
    codex:  '/static/icons/openai.svg',
  };
  function pathFor(agent) {
    return PATHS[agent] || PATHS.claude;
  }
  function setFavicon(agent) {
    const link = document.getElementById('favicon');
    if (!link) return;
    link.setAttribute('type', 'image/svg+xml');
    link.setAttribute('href', pathFor(agent));
  }
  function setAgentMark(imgEl, agent) {
    if (!imgEl) return;
    imgEl.setAttribute('src', pathFor(agent));
    imgEl.setAttribute('alt', agent === 'codex' ? 'codex' : 'claude');
    imgEl.removeAttribute('hidden');
  }
  window.AgentIcons = { pathFor, setFavicon, setAgentMark };
})();
