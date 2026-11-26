'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('Foreplay research help is available without a key or profile', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'research-help-'));
  t.after(() => fs.rmSync(home, {recursive:true, force:true}));
  const help = execFileSync(process.execPath, [path.join(__dirname,'../bin/dshproxy.js'),'research','help'], {encoding:'utf8',env:{...process.env,DSHPROXY_HOME:home,FOREPLAY_API_KEY:''}});
  assert.match(help,/boards/); assert.match(help,/search/); assert.match(help,/confirm-credits/);
  assert.deepEqual(fs.readdirSync(home), []);
});
