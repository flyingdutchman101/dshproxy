'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { homeDir } = require('../settings');
const { withLock, replaceFile } = require('../filelock');
function decision(home = homeDir()) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'foreplay-tools.json'), 'utf8')).enabled === true; }
  catch (error) { return error.code === 'ENOENT' ? undefined : false; }
}
function enabled(home) { return decision(home) === true; }
async function set(home = homeDir(), on) {
  const target = path.join(home, 'foreplay-tools.json');
  fs.mkdirSync(home, { recursive: true });
  await withLock(target, () => replaceFile(target, JSON.stringify({ enabled: on === true }) + '\n'));
}
module.exports = { enabled, set, decision };
