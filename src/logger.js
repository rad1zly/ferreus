'use strict';

const config = require('./config');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[config.LOG_LEVEL] ?? 1;

function log(level, ...args) {
  if ((LEVELS[level] ?? 1) < currentLevel) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  console.log(line);
}

module.exports = {
  debug: (...args) => log('debug', ...args),
  info: (...args) => log('info', ...args),
  warn: (...args) => log('warn', ...args),
  error: (...args) => log('error', ...args),
};
