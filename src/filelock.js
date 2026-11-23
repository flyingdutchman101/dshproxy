'use strict';
// Several DSHProxy commands can run at the same moment. A command that reads
// a file, changes what it read and writes it back must not do so while
// another does the same, or one of the two changes is lost. This module has
// the three pieces for that:
//
//   withLock(target, work)        runs `work` while no other command holds the
//                                 lock of `target`
//   replaceFile(target, text)     puts new content in place as a whole
//   createIfAbsent(target, text)  creates a file only where there is none
//
// The lock is a file beside the target, `<target>.lock`, holding who took it
// and when. Readers of the target take no lock: replaceFile never shows them
// a half-written file.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// How long a command waits for the lock, and how old a lock must be before a
// command may take it from a holder that is still running.
const WAIT_MS = 10 * 1000;
const STALE_MS = 30 * 1000;
// The longest single pause while waiting; pauses are random up to this.
const MAX_PAUSE_MS = 100;
// Pauses between attempts to put a file in place that Windows refuses because
// another program has the old one open: seven attempts within two thirds of a second.
const REPLACE_PAUSES_MS = [10, 20, 40, 80, 160, 320];
// What Windows answers while another program has the file open, or while a
// file that was just deleted is still closing.
const IN_USE = new Set(['EPERM', 'EBUSY', 'EACCES']);

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function temporaryName(target) {
  return `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
}

// Removes a file of ours. A file that cannot be removed right now is left:
// nothing here depends on it being gone.
function discard(file) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.unlinkSync(file);
      return;
    } catch (error) {
      if (!IN_USE.has(error.code)) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * (attempt + 1));
    }
  }
}

// Puts the finished file `temporary` at `target` unless something is there.
// A hard link does that in one step, so nobody ever sees `target` without its
// whole content. Where the file system has no hard links the file is created
// exclusively and then written, which is as close as it gets there.
function place(temporary, target, text, link) {
  try {
    link(temporary, target);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
  }
  let handle;
  try {
    handle = fs.openSync(target, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    fs.writeSync(handle, text);
  } catch (error) {
    fs.closeSync(handle);
    handle = null;
    discard(target);
    throw error;
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
  return true;
}

// Creates `target` with `text` unless it exists. Returns whether this call
// created it. Of several calls at the same moment exactly one returns true,
// and an existing file is never touched.
function createIfAbsent(target, text, { link = fs.linkSync } = {}) {
  const temporary = temporaryName(target);
  fs.writeFileSync(temporary, text, { flag: 'wx' });
  try {
    return place(temporary, target, text, link);
  } finally {
    discard(temporary);
  }
}

// Replaces `target` with `text`: written beside it first and then renamed
// over it, so a reader sees the old content or the new and never a part.
// Windows refuses the rename while another program has the old file open;
// that is tried again for a moment before giving up.
async function replaceFile(target, text, { rename = fs.renameSync, sleep = realSleep } = {}) {
  const temporary = temporaryName(target);
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx' });
    for (let attempt = 0; ; attempt += 1) {
      try {
        rename(temporary, target);
        return;
      } catch (error) {
        if (!IN_USE.has(error.code)) throw error;
        if (attempt === REPLACE_PAUSES_MS.length) throw new Error(`${target} could not be replaced (${error.code}): another program may have it open. Nothing was saved.`);
        await sleep(REPLACE_PAUSES_MS[attempt]);
      }
    }
  } finally {
    discard(temporary);
  }
}

// ------------------------------- the lock -------------------------------

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// What lies at the lock's path: null when nothing does. A lock written by
// this module names its holder; anything else is known only by its content
// and its age.
function inspect(lockFile) {
  let text;
  let changed;
  try {
    text = fs.readFileSync(lockFile, 'utf8');
    changed = fs.statSync(lockFile).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const { id, pid, at } = JSON.parse(text);
    if (typeof id === 'string' && /^[0-9a-f]{24}$/.test(id) && Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(at)) return { id, pid, at };
  } catch {
    // not a lock of ours
  }
  return { id: crypto.createHash('sha256').update(`${changed}\n${text}`).digest('hex').slice(0, 24), pid: null, at: changed };
}

// A lock may be taken from its holder when the holder's process is gone, or
// when the lock is older than any change takes.
function abandoned(lock, now, staleMs) {
  return (lock.pid !== null && !alive(lock.pid)) || now - lock.at > staleMs;
}

// Removing a lock that someone else may be removing or replacing at the same
// moment needs care: "it is still the old one" and "delete it" are two steps,
// and between them the file at that path can have become a new holder's lock.
// So a lock is removed only by the one process that holds the claim on it: a
// file `<lock>.<id of that lock>.t<N>`, created exclusively. An ID is never
// used twice, so a claim cannot be mistaken for a claim on a later lock.
//
// A claim whose process died is superseded by the next number, again created
// exclusively. Returns the claim files to remove afterwards, or null when
// another process holds the claim.
function claim(lockFile, id, now, staleMs) {
  const dir = path.dirname(lockFile);
  const prefix = `${path.basename(lockFile)}.${id}.t`;
  let levels;
  try {
    levels = fs.readdirSync(dir).filter((name) => name.startsWith(prefix) && /^[1-9]\d{0,5}$/.test(name.slice(prefix.length))).map((name) => Number(name.slice(prefix.length))).sort((a, b) => a - b);
  } catch {
    return null;
  }
  const top = levels.length ? levels[levels.length - 1] : 0;
  if (top) {
    try {
      const file = path.join(dir, `${prefix}${top}`);
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      const gone = Number.isSafeInteger(pid) && pid > 0 && !alive(pid);
      if (!gone && now - fs.statSync(file).mtimeMs <= staleMs) return null;
    } catch {
      return null;
    }
  }
  const mine = path.join(dir, `${prefix}${top + 1}`);
  try {
    fs.writeFileSync(mine, `${process.pid}\n`, { flag: 'wx' });
  } catch {
    return null;
  }
  return [...levels.map((level) => path.join(dir, `${prefix}${level}`)), mine];
}

// Removes the lock with this ID, if that is still the lock at the path.
// Returns "removed", "other" when another lock or none is there, or "claimed"
// when another process is removing this very lock.
function removeLock(lockFile, id, now, staleMs) {
  const claims = claim(lockFile, id, now, staleMs);
  if (!claims) return 'claimed';
  try {
    let current = null;
    try {
      current = inspect(lockFile);
    } catch {
      // cannot be read right now: left alone
    }
    if (!current || current.id !== id) return 'other';
    discard(lockFile);
    return 'removed';
  } finally {
    // Our own claim last: until then nobody else can claim this ID.
    for (const file of claims) discard(file);
  }
}

// Claims on locks that are gone: left by a process that died half way.
function clearOldClaims(lockFile, id) {
  const dir = path.dirname(lockFile);
  const prefix = `${path.basename(lockFile)}.`;
  let found;
  try {
    found = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of found) {
    if (!name.startsWith(prefix)) continue;
    const match = /^([0-9a-f]{24})\.t[1-9]\d{0,5}$/.exec(name.slice(prefix.length));
    if (match && match[1] !== id) discard(path.join(dir, name));
  }
}

// One attempt to take the lock. True when taken; otherwise false, or the
// error Windows gave when the path could not be written to just now.
function acquire(lockFile, id, now, link, staleMs) {
  for (let pass = 0; pass < 3; pass += 1) {
    const temporary = temporaryName(lockFile);
    const text = `${JSON.stringify({ id, pid: process.pid, at: now() })}\n`;
    fs.writeFileSync(temporary, text, { flag: 'wx' });
    try {
      if (place(temporary, lockFile, text, link)) return true;
    } catch (error) {
      if (!IN_USE.has(error.code)) throw error;
      return error;
    } finally {
      discard(temporary);
    }
    let lock;
    try {
      lock = inspect(lockFile);
    } catch (error) {
      if (!IN_USE.has(error.code)) throw error;
      return false;
    }
    // Gone meanwhile, or removed here because its holder is: try again at once.
    if (lock && (!abandoned(lock, now(), staleMs) || removeLock(lockFile, lock.id, now(), staleMs) === 'claimed')) return false;
  }
  return false;
}

function pause(attempt) {
  return 1 + Math.floor(Math.random() * Math.min(MAX_PAUSE_MS, 8 * (attempt + 1)));
}

// Runs `work` while this command holds the lock of `target`, and returns what
// it returns. The lock is released when `work` ends, also when it throws.
//
// Waits up to `waitMs` for another command to finish and then refuses. A lock
// whose holder is gone, or that is older than 30 seconds, is taken over. If
// that happened to this command's own lock while `work` ran, the call fails
// although `work` succeeded: its change may have been overwritten.
//
// Take the lock late and hold it briefly: do slow things, like unlocking the
// master key, before the call. A caller whose work cannot be that brief says
// with `staleMs` how old the lock of a holder that is still running must be
// before it is taken over; it must be longer than the work can take.
async function withLock(target, work, { waitMs = WAIT_MS, staleMs = STALE_MS, now = Date.now, sleep = realSleep, link = fs.linkSync } = {}) {
  const stale = Number.isFinite(staleMs) && staleMs >= STALE_MS ? staleMs : STALE_MS;
  const lockFile = `${target}.lock`;
  const id = crypto.randomBytes(12).toString('hex');
  const limit = Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : WAIT_MS;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = now() + limit;
  for (let attempt = 0; ; attempt += 1) {
    const taken = acquire(lockFile, id, now, link, stale);
    if (taken === true) break;
    const left = deadline - now();
    if (left <= 0) {
      if (taken instanceof Error) throw taken;
      throw Object.assign(new Error(`Another DSHProxy command is changing ${target} and did not finish within ${limit / 1000} second${limit === 1000 ? '' : 's'}, so nothing was saved.`), { code: 'DSHPROXY_BUSY' });
    }
    await sleep(Math.min(pause(attempt), left));
  }
  let result;
  try {
    clearOldClaims(lockFile, id);
    result = await work();
  } catch (error) {
    removeLock(lockFile, id, now(), stale);
    throw error;
  }
  if (removeLock(lockFile, id, now(), stale) !== 'removed') {
    throw Object.assign(new Error(`Another DSHProxy command took over ${target} while it was being changed, so the change may not have been kept. Run the command again.`), { code: 'DSHPROXY_LOCK_LOST' });
  }
  return result;
}

module.exports = { withLock, replaceFile, createIfAbsent };
