'use strict';
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const MAX_AUDIO = 25 * 1024 * 1024;
async function readInput(file, limit) {
  let handle;
  try {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error();
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size < 1 || stat.size > limit) throw new Error();
    // Bounded even if the file grows after stat.
    const bytes = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
    const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error();
    return bytes.subarray(0, bytesRead);
  } catch { throw new Error('Input must be a nonempty regular file, not a symlink, within the local size limit.'); }
  finally { await handle?.close(); }
}
async function reserveOutput(file) {
  let target, handle;
  try {
    if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error();
    target = path.join(await fs.realpath(path.dirname(path.resolve(file))), path.basename(file));
    handle = await fs.open(target, 'wx', 0o600);
  } catch { throw new Error('Output must be a new file in an existing directory; overwriting is refused.'); }
  const original = await handle.stat();
  let complete = false;
  return {
    async save(bytes) { await handle.writeFile(bytes); await handle.sync(); complete = true; },
    async close() {
      await handle.close();
      if (!complete) {
        // Only remove our own reserved file, never a concurrently replaced path.
        const current = await fs.lstat(target).catch(()=>null);
        if (current && current.ino === original.ino && current.dev === original.dev && current.isFile()) await fs.unlink(target);
      }
    }
  };
}
module.exports = {readInput, reserveOutput, MAX_AUDIO};
