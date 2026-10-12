// 复用实际500夹具、四会话与finally清理，避免维护第二套容量输入。
process.argv.push('--compare-fixed');
await import('./verify-project-capacity.mjs');
