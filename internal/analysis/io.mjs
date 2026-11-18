// Owned analysis configuration and file I/O. Never imports candidate code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(moduleRoot, '../..');
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
export function walk(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e => {
    const name = path.posix.join(prefix, e.name);
    if (e.isSymbolicLink()) return [];
    if (e.isDirectory()) return ['.git', 'node_modules', '.cache'].includes(e.name) ? [] : walk(root, name);
    return e.isFile() ? [name] : [];
  });
}
export function packageInfo(name) {
  // Resolve from this installed package, including nested pnpm dependencies.
  const from = name === '@ts-morph/common'
    ? createRequire(import.meta.resolve('ts-morph')) : createRequire(import.meta.url);
  let dir;
  try { dir = path.dirname(from.resolve(name + '/package.json')); }
  catch { dir = path.dirname(fileURLToPath(import.meta.resolve(name))); }
  while (true) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (metadata.name === name) return { dir, ...metadata };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw Error('Analysis dependency unavailable: ' + name);
    dir = parent;
  }
}
export function astBinary() {
  // This release's measured native launcher is Windows x64. Other targets fail
  // explicitly rather than executing a global CLI or a dependency postinstall.
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('Analysis ast-grep launcher currently supports Windows x64 only');
  const from = createRequire(path.join(packageInfo('@ast-grep/cli').dir, 'package.json'));
  return path.join(path.dirname(from.resolve('@ast-grep/cli-win32-x64-msvc/package.json')), 'ast-grep.exe');
}
export const codeFile = name => path.join(name === 'package.json' ? packageRoot : moduleRoot, name);
