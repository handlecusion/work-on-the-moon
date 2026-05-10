'use strict';
(function () {
  const PATHS = {
    claude: '/static/icons/anthropic.svg',
    codex:  '/static/icons/openai.svg',
    hermes: '/static/icons/hermes.svg',
  };
  const ALTS = { claude: 'claude', codex: 'codex', hermes: 'hermes' };
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
    imgEl.setAttribute('alt', ALTS[agent] || ALTS.claude);
    imgEl.removeAttribute('hidden');
  }
  window.AgentIcons = { pathFor, setFavicon, setAgentMark };
})();
