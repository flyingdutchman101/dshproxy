'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const MODULE = path.join(__dirname, '..', 'src', 'filelock.js');
const { withLock, replaceFile, createIfAbsent } = require(MODULE);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-filelock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const names = (dir) => fs.readdirSync(dir).sort();
const lockOf = (target) => `${target}.lock`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { open, opened };
}

// The ID of a process that has just ended.
function deadPid() {
  return spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
}

// A lock file as another DSHProxy process would have left it: this is the
// format the processes share.
const ID = 'a1b2c3d4e5f6a7b8c9d0e1f2';
function placeLock(target, { id = ID, pid = process.pid, at = Date.now() } = {}) {
  const text = `${JSON.stringify({ id, pid, at })}\n`;
  fs.writeFileSync(lockOf(target), text);
  return text;
}

// Time that passes only when the lock waits, so no test waits for real.
function fakeClock(start = 1_700_000_000_000) {
  const clock = { time: start, sleeps: [], now: () => clock.time, sleep: async (ms) => { clock.sleeps.push(ms); clock.time += ms; } };
  return clock;
}
const timing = (clock) => ({ now: clock.now, sleep: clock.sleep });
const busyMessage = (target, seconds = 10) => `Another DSHProxy command is changing ${target} and did not finish within ${seconds} seconds, so nothing was saved.`;
const lostMessage = (target) => `Another DSHProxy command took over ${target} while it was being changed, so the change may not have been kept. Run the command again.`;

// ------------------------------- holding and releasing -------------------------------

test('work runs while a lock file lies beside the target, and the file is gone afterwards', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  const result = await withLock(target, async () => {
    assert.deepEqual(names(dir), ['data.json.lock']);
    const held = JSON.parse(fs.readFileSync(lockOf(target), 'utf8'));
    assert.equal(held.pid, process.pid);
    assert.ok(Math.abs(held.at - Date.now()) < 5000);
    assert.match(held.id, /^[0-9a-f]{24}$/);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.deepEqual(names(dir), []);
});

test('the lock file is removed when the work throws or rejects', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  await assert.rejects(withLock(target, () => { throw new Error('synthetic failure'); }), /synthetic failure/);
  assert.deepEqual(names(dir), []);
  await assert.rejects(withLock(target, async () => { await pause(1); throw new Error('later failure'); }), /later failure/);
  assert.deepEqual(names(dir), []);
  // And it can be taken again at once.
  assert.equal(await withLock(target, () => 7), 7);
});

test('work on one target never overlaps; work on another target is not held up', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  const first = gate();
  const inside = gate();
  const order = [];
  const a = withLock(target, async () => { order.push('a in'); inside.open(); await first.opened; order.push('a out'); });
  await inside.opened;

  const waiting = gate();
  const b = withLock(target, async () => { order.push('b in'); }, { sleep: async () => { waiting.open(); await pause(1); } });
  await waiting.opened;
  assert.deepEqual(order, ['a in']);
  // Another file has another lock.
  assert.equal(await withLock(path.join(dir, 'other.json'), () => 'free'), 'free');
  assert.deepEqual(order, ['a in']);

  first.open();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a in', 'a out', 'b in']);
  assert.deepEqual(names(dir), []);
});

test('changes started together each see the one before: none is lost', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'count.txt');
  fs.writeFileSync(target, '0');
  let active = 0;
  let most = 0;
  await Promise.all(Array.from({ length: 20 }, () => withLock(target, async () => {
    active += 1;
    most = Math.max(most, active);
    const count = Number(fs.readFileSync(target, 'utf8'));
    await new Promise((resolve) => setImmediate(resolve));
    fs.writeFileSync(target, String(count + 1));
    active -= 1;
  })));
  assert.equal(fs.readFileSync(target, 'utf8'), '20');
  assert.equal(most, 1);
  assert.deepEqual(names(dir), ['count.txt']);
});

// ------------------------------- waiting and giving up -------------------------------

test('a lock that stays held is waited for 10 seconds, in short uneven steps, and then refused with one sentence', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  const clock = fakeClock();
  const theirs = placeLock(target, { at: clock.now() });
  let ran = false;
  await assert.rejects(withLock(target, () => { ran = true; }, timing(clock)), (error) => {
    assert.equal(error.message, busyMessage(target));
    assert.equal(error.code, 'DSHPROXY_BUSY');
    return true;
  });
  assert.equal(ran, false);
  const waited = clock.sleeps.reduce((sum, ms) => sum + ms, 0);
  assert.equal(waited, 10000);
  assert.ok(clock.sleeps.length >= 100, `${clock.sleeps.length} steps`);
  assert.ok(clock.sleeps.every((ms) => Number.isInteger(ms) && ms >= 1 && ms <= 100), 'a step outside 1 to 100 ms');
  // Random, not a fixed rising series: short steps keep turning up late in the wait.
  assert.ok(clock.sleeps.slice(20, -1).filter((ms) => ms < 50).length >= 10, 'the steps are not random');
  // The other command's lock is left exactly as it was.
  assert.equal(fs.readFileSync(lockOf(target), 'utf8'), theirs);
  assert.deepEqual(names(dir), ['data.json.lock']);
});

test('the wait can be set, and no wait at all refuses at once', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  const clock = fakeClock();
  placeLock(target, { at: clock.now() });
  await assert.rejects(withLock(target, () => {}, { ...timing(clock), waitMs: 1000 }), { message: busyMessage(target, 1).replace('1 seconds', '1 second') });
  assert.equal(clock.sleeps.reduce((sum, ms) => sum + ms, 0), 1000);
  const none = fakeClock();
  await assert.rejects(withLock(target, () => {}, { ...timing(none), waitMs: 0 }), { code: 'DSHPROXY_BUSY' });
  assert.deepEqual(none.sleeps, []);
});

test('a waiting command gets the lock as soon as it is released', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  const clock = fakeClock();
  placeLock(target, { at: clock.now() });
  let steps = 0;
  const sleep = async (ms) => {
    await clock.sleep(ms);
    steps += 1;
    if (steps === 3) fs.rmSync(lockOf(target));
  };
  assert.equal(await withLock(target, () => 'ran', { now: clock.now, sleep }), 'ran');
  assert.equal(steps, 3);
  assert.deepEqual(names(dir), []);
});

// ------------------------------- a lock left behind -------------------------------

test('a lock whose process no longer exists is taken over at once', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  const clock = fakeClock();
  placeLock(target, { pid: deadPid(), at: clock.now() });
  let mine = null;
  assert.equal(await withLock(target, () => { mine = JSON.parse(fs.readFileSync(lockOf(target), 'utf8')); return 'ran'; }, timing(clock)), 'ran');
  assert.deepEqual(clock.sleeps, []);
  assert.equal(mine.pid, process.pid);
  assert.notEqual(mine.id, ID);
  assert.deepEqual(names(dir), []);
});

test('a lock of a living process is taken over only once it is older than 30 seconds', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  const old = fakeClock();
  placeLock(target, { at: old.now() - 30001 });
  assert.equal(await withLock(target, () => 'ran', timing(old)), 'ran');
  assert.deepEqual(old.sleeps, []);

  // Younger than that, it is waited for; here until it has turned 30 seconds old.
  const young = fakeClock();
  placeLock(target, { at: young.now() - 28000 });
  await assert.rejects(withLock(target, () => {}, { ...timing(young), waitMs: 1500 }), { code: 'DSHPROXY_BUSY' });
  assert.equal(await withLock(target, () => 'later', { ...timing(young), waitMs: 1500 }), 'later');
  const waited = young.sleeps.reduce((sum, ms) => sum + ms, 0);
  assert.ok(waited > 2000 && waited <= 2100, `waited ${waited}`);
  assert.deepEqual(names(dir), []);
});

test('a lock file that is not one of ours counts as held while it is fresh and is taken over when it is old', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  for (const text of ['', 'not a lock', '{"id":7}', '[]', JSON.stringify({ id: ID, pid: 'x', at: 1 })]) {
    fs.writeFileSync(lockOf(target), text);
    await assert.rejects(withLock(target, () => {}, { waitMs: 30 }), { code: 'DSHPROXY_BUSY' });
    assert.equal(fs.readFileSync(lockOf(target), 'utf8'), text);
    const longAgo = new Date(Date.now() - 31000);
    fs.utimesSync(lockOf(target), longAgo, longAgo);
    assert.equal(await withLock(target, () => 'ran', { waitMs: 30 }), 'ran');
    assert.deepEqual(names(dir), []);
  }
});

test('only one waiter takes a lock over: one that finds another already doing so waits', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  const clock = fakeClock();
  const stale = placeLock(target, { pid: deadPid(), at: clock.now() });
  // Another living process has claimed the takeover of exactly this lock.
  const claim = `${lockOf(target)}.${ID}.t1`;
  fs.writeFileSync(claim, `${process.pid}\n`);
  let ran = false;
  await assert.rejects(withLock(target, () => { ran = true; }, { ...timing(clock), waitMs: 500 }), { code: 'DSHPROXY_BUSY' });
  assert.equal(ran, false);
  assert.equal(fs.readFileSync(lockOf(target), 'utf8'), stale);
  assert.deepEqual(names(dir), ['data.json.lock', `data.json.lock.${ID}.t1`]);
});

test('a waiter that is overtaken between looking and claiming does not take over as well', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  const clock = fakeClock();
  const stale = placeLock(target, { pid: deadPid(), at: clock.now() });
  // Another living process claims the takeover in the instant after this one
  // has looked for claims and found none. Only the file system can show that
  // instant, so the listing of the folder is what is stood in for here.
  const claim = `${lockOf(target)}.${ID}.t1`;
  const theirs = `${process.ppid}\n`;
  const list = fs.readdirSync;
  t.after(() => { fs.readdirSync = list; });
  fs.readdirSync = (...args) => {
    const found = list(...args);
    if (args[0] === dir && !fs.existsSync(claim)) fs.writeFileSync(claim, theirs);
    return found;
  };
  let ran = false;
  await assert.rejects(withLock(target, () => { ran = true; }, { ...timing(clock), waitMs: 300 }), { code: 'DSHPROXY_BUSY' });
  fs.readdirSync = list;
  assert.equal(ran, false);
  assert.equal(fs.readFileSync(claim, 'utf8'), theirs);
  assert.equal(fs.readFileSync(lockOf(target), 'utf8'), stale);
  assert.deepEqual(names(dir), ['data.json.lock', `data.json.lock.${ID}.t1`]);
});

test('a takeover left half done by a process that died is finished by the next command', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  const gone = deadPid();
  placeLock(target, { pid: gone });
  fs.writeFileSync(`${lockOf(target)}.${ID}.t1`, `${gone}\n`);
  fs.writeFileSync(`${lockOf(target)}.${ID}.t2`, `${gone}\n`);
  assert.equal(await withLock(target, () => 'ran', { waitMs: 200 }), 'ran');
  assert.deepEqual(names(dir), []);
});

test('a command whose lock was taken over is told that its change may not have been kept, and leaves the new holder\'s lock alone', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  const clock = fakeClock();
  const slow = gate();
  const inside = gate();
  const a = withLock(target, async () => { inside.open(); await slow.opened; return 'a'; }, timing(clock));
  await inside.opened;

  // More than 30 seconds later another command may take the lock.
  clock.time += 30001;
  const second = gate();
  const taken = gate();
  const b = withLock(target, async () => { taken.open(); await second.opened; return 'b'; }, timing(clock));
  await taken.opened;
  const theirs = fs.readFileSync(lockOf(target), 'utf8');

  slow.open();
  await assert.rejects(a, { code: 'DSHPROXY_LOCK_LOST', message: lostMessage(target) });
  assert.equal(fs.readFileSync(lockOf(target), 'utf8'), theirs);
  second.open();
  assert.equal(await b, 'b');
  assert.deepEqual(names(dir), []);
});

test('work that fails after its lock was taken over fails with its own error', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  const clock = fakeClock();
  const slow = gate();
  const inside = gate();
  const a = withLock(target, async () => { inside.open(); await slow.opened; throw new Error('synthetic failure'); }, timing(clock));
  await inside.opened;
  clock.time += 30001;
  await withLock(target, () => {}, timing(clock));
  slow.open();
  await assert.rejects(a, /synthetic failure/);
  assert.deepEqual(names(dir), []);
});

test('a release that meets a takeover of its own lock in progress leaves the removal to it', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  let claim = null;
  await assert.rejects(withLock(target, () => {
    const { id } = JSON.parse(fs.readFileSync(lockOf(target), 'utf8'));
    claim = `${lockOf(target)}.${id}.t1`;
    fs.writeFileSync(claim, `${process.pid}\n`);
  }), { code: 'DSHPROXY_LOCK_LOST' });
  assert.deepEqual(names(dir), ['data.json.lock', path.basename(claim)]);
});

test('marks of a takeover that ended long ago are cleared by the next command', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  const leftovers = [`data.json.lock.${ID}.t1`, `data.json.lock.${ID}.t2`];
  for (const name of leftovers) fs.writeFileSync(path.join(dir, name), `${deadPid()}\n`);
  // Files that only look similar are not ours to remove.
  const others = ['data.json.lock.bak', `data.json.lock.${ID}.t1.txt`, `other.json.lock.${ID}.t1`];
  for (const name of others) fs.writeFileSync(path.join(dir, name), 'kept');
  await withLock(target, () => {});
  assert.deepEqual(names(dir), [...others].sort());
});
// ------------------------------- several processes -------------------------------


// Each child reports that it is ready and then waits for the file `go`, so
// that all of them start their work within the same millisecond or so.
const startTogether = `
  const fs = require('node:fs');
  const go = process.argv[1];
  const ready = () => new Promise((resolve) => {
    fs.writeFileSync(go + '.ready.' + process.pid, '');
    const look = () => (fs.existsSync(go) ? resolve() : setImmediate(look));
    look();
  });`;
async function together(dir, count, body, ...args) {
  const go = path.join(dir, 'go');
  const script = `${startTogether}\n(async () => { await ready();\n${body}\n})().catch((error) => { process.stderr.write(String(error && error.stack || error)); process.exit(1); });`;
  const runs = Array.from({ length: count }, (_, index) => new Promise((resolve) => {
    const proc = spawn(process.execPath, ['-e', script, go, String(index), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('close', (status) => resolve({ status, stdout, stderr }));
  }));
  const deadline = Date.now() + 30000;
  while (fs.readdirSync(dir).filter((name) => name.startsWith('go.ready.')).length < count) {
    assert.ok(Date.now() < deadline, 'the child processes did not start');
    await pause(5);
  }
  fs.writeFileSync(go, '');
  const results = await Promise.all(runs);
  for (const name of fs.readdirSync(dir)) if (name === 'go' || name.startsWith('go.ready.')) fs.rmSync(path.join(dir, name));
  return results;
}

test('four processes that find the same abandoned lock at the same moment change the file one at a time: no change is lost', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'count.txt');
  fs.writeFileSync(target, '0');
  placeLock(target, { pid: deadPid() });
  const results = await together(dir, 4, `
    const { withLock } = require(${JSON.stringify(MODULE)});
    const target = process.argv[3];
    for (let round = 0; round < 25; round += 1) {
      await withLock(target, async () => {
        const count = Number(fs.readFileSync(target, 'utf8'));
        await new Promise((resolve) => setImmediate(resolve));
        fs.writeFileSync(target, String(count + 1));
      });
    }`, target);
  for (const result of results) assert.deepEqual([result.status, result.stderr], [0, '']);
  assert.equal(fs.readFileSync(target, 'utf8'), '100');
  assert.deepEqual(names(dir), ['count.txt']);
});

test('four processes that create the same file at the same moment: exactly one creates it, and its content is whole', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'once.txt');
  const results = await together(dir, 4, `
    const { createIfAbsent } = require(${JSON.stringify(MODULE)});
    const text = process.argv[2].repeat(20000) + '\\n';
    process.stdout.write(JSON.stringify(createIfAbsent(process.argv[3], text)));`, target);
  for (const result of results) assert.deepEqual([result.status, result.stderr], [0, '']);
  const created = results.map((result) => JSON.parse(result.stdout));
  assert.deepEqual([...created].sort(), [false, false, false, true]);
  const winner = String(created.indexOf(true));
  assert.equal(fs.readFileSync(target, 'utf8'), `${winner.repeat(20000)}\n`);
  assert.deepEqual(names(dir), ['once.txt']);
  assert.equal(fs.statSync(target).nlink, 1);
});

// ------------------------------- creating and replacing files -------------------------------

test('a file is created only where there is none, with its whole content at once', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'once.txt');
  assert.equal(createIfAbsent(target, 'first\n'), true);
  assert.equal(createIfAbsent(target, 'second\n'), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'first\n');
  assert.deepEqual(names(dir), ['once.txt']);
  assert.equal(fs.statSync(target).nlink, 1);
});

test('where the file system has no hard links, creation is still refused when the file exists', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'once.txt');
  let asked = 0;
  const noLinks = () => {
    asked += 1;
    throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
  };
  assert.equal(createIfAbsent(target, 'first\n', { link: noLinks }), true);
  assert.equal(createIfAbsent(target, 'second\n', { link: noLinks }), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'first\n');
  assert.deepEqual(names(dir), ['once.txt']);
  // A folder that cannot be written to is an error, not "it exists".
  assert.throws(() => createIfAbsent(path.join(dir, 'missing', 'once.txt'), 'x'), /ENOENT/);
  // And a lock works there too.
  assert.equal(asked, 2);
  return withLock(target, () => { assert.deepEqual(names(dir), ['once.txt', 'once.txt.lock']); }, { link: noLinks }).then(() => {
    assert.equal(asked, 3);
    assert.deepEqual(names(dir), ['once.txt']);
  });
});

test('a file is replaced as a whole and no temporary file stays', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  await replaceFile(target, 'one\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'one\n');
  await replaceFile(target, 'two\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'two\n');
  assert.deepEqual(names(dir), ['data.json']);
});

test('a replacement that Windows refuses because the file is open elsewhere is tried again, briefly', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  fs.writeFileSync(target, 'old\n');
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const sleeps = [];
    let calls = 0;
    const rename = (from, to) => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error(`${code}: synthetic, rename`), { code });
      fs.renameSync(from, to);
    };
    await replaceFile(target, `new ${code}\n`, { rename, sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(fs.readFileSync(target, 'utf8'), `new ${code}\n`);
    assert.deepEqual([calls, sleeps], [3, [10, 20]]);
    assert.deepEqual(names(dir), ['data.json']);
  }
});

test('a replacement that stays refused gives up within about a second with one sentence, and the file is as it was', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  fs.writeFileSync(target, 'old\n');
  const sleeps = [];
  let calls = 0;
  const rename = () => {
    calls += 1;
    throw Object.assign(new Error('EBUSY: resource busy or locked, rename synthetic-SECRET'), { code: 'EBUSY' });
  };
  await assert.rejects(replaceFile(target, 'new\n', { rename, sleep: async (ms) => { sleeps.push(ms); } }), (error) => {
    assert.equal(error.message, `${target} could not be replaced (EBUSY): another program may have it open. Nothing was saved.`);
    return true;
  });
  assert.equal(calls, sleeps.length + 1);
  assert.ok(calls >= 5 && calls <= 10, `${calls} attempts`);
  const waited = sleeps.reduce((sum, ms) => sum + ms, 0);
  assert.ok(waited >= 300 && waited <= 1500, `waited ${waited} ms`);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old\n');
  assert.deepEqual(names(dir), ['data.json']);
});

test('any other failure to replace a file is passed on at once', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'data.json');
  let calls = 0;
  const rename = () => {
    calls += 1;
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  await assert.rejects(replaceFile(target, 'new\n', { rename, sleep: async () => { throw new Error('must not wait'); } }), /ENOSPC/);
  assert.equal(calls, 1);
  assert.deepEqual(names(dir), []);
});
