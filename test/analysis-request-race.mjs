// Test-only writer: change actual source bytes when the scanner reads them,
// then restore after analyze's final validity check, before worker admission.
// The real collector, scanner, byte checks and source validator are untouched.
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const source = process.env.FISH_REQUEST_RACE_SOURCE;
if (source) {
  const read = fs.readFileSync, write = fs.writeFileSync, append = fs.appendFileSync;
  let original, changed = false;
  fs.readFileSync = function(file, ...args) {
    if (!changed && path.resolve(String(file)) === path.resolve(source)
      && new Error().stack.includes('/internal/analysis/scan.mjs:')) {
      original = read(source); write(source, Buffer.from(original.toString().replace('VALUE=1', 'VALUE=2')));
      changed = true;
    }
    return read.call(this, file, ...args);
  };
  fs.appendFileSync = function(file, data, ...args) {
    if (changed && String(file).endsWith('operations.jsonl')) {
      const event = JSON.parse(String(data));
      if (event.action === 'initial' && event.analyzerExecutions === 1) {
        write(source, original);
        write(process.env.FISH_REQUEST_RACE_MARKER, JSON.stringify({ changedDuringCopy: true, restoredBeforeAdmission: true, pid: process.pid }));
      }
    }
    return append.call(this, file, data, ...args);
  };
  syncBuiltinESMExports();
}
