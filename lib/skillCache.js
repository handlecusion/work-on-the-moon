'use strict';

let cache = { skills: [], agents: [], plugins: [], updatedAt: null };

module.exports = {
  set(payload) {
    cache = {
      skills: Array.isArray(payload.skills) ? [...new Set(payload.skills)] : cache.skills,
      agents: Array.isArray(payload.agents) ? [...new Set(payload.agents)] : cache.agents,
      plugins: Array.isArray(payload.plugins) ? payload.plugins : cache.plugins,
      updatedAt: new Date().toISOString()
    };
  },
  get() { return cache; }
};
