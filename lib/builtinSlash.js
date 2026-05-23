'use strict';

module.exports = [
  { name: '/help', description: 'Get help with using Claude Code' },
  { name: '/clear', description: 'Clear the conversation' },
  { name: '/compact', description: 'Compact the conversation history' },
  { name: '/cost', description: 'Show session cost so far' },
  { name: '/usage', description: 'Show subscription usage' },
  { name: '/login', description: 'Sign in to Anthropic account' },
  { name: '/logout', description: 'Sign out' },
  { name: '/memory', description: 'Open persistent memory file' },
  { name: '/init', description: 'Initialize CLAUDE.md for this codebase' },
  { name: '/agents', description: 'List or manage configured agents' },
  { name: '/mcp', description: 'Show MCP server status' },
  { name: '/doctor', description: 'Diagnose installation' },
  { name: '/review', description: 'Review a pull request' },
  { name: '/security-review', description: 'Security review of pending changes' },
  { name: '/context', description: 'Show context window utilization' },
  { name: '/insights', description: 'Show session insights' },
  { name: '/heapdump', description: 'Capture a heap snapshot' },
  { name: '/quit', description: '대화창 나가기 (세션은 보존)' },
  { name: '/exit', description: '대화창 나가기 (세션은 보존)' }
];
