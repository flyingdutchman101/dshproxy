import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// Read only the dedicated decision file; never the provider/key settings.
export function foreplayAllowed(home, fallback = false) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'foreplay-tools.json'), 'utf8')).enabled === true }
  catch (error) { return error.code === 'ENOENT' && fallback === true }
}
export function foreplayHome(settings, host) {
  return settings.env.DSHPROXY_HOME || path.join(host.env.HOME || host.env.USERPROFILE || os.homedir(), '.dshproxy')
}
