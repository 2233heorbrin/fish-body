import { realpathSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
/** Compare filesystem identities without changing historical signed bytes. */
export function pathIdentity(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let path = resolve(value.replace(/\\/g, '/'));
  if (existsSync(path)) path = realpathSync.native(path);
  path = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? path.toLowerCase() : path;
}
export const samePath = (a, b) => pathIdentity(a) !== null && pathIdentity(a) === pathIdentity(b);
