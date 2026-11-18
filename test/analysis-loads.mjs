// Preload in both the test process and inherited analysis children.
import { registerHooks } from 'node:module';
import fs from 'node:fs';

if (!process.env.FISH_ANALYSIS_LOAD_LOG) throw Error('FISH_ANALYSIS_LOAD_LOG is required');
registerHooks({ load(url, context, next) {
  if (/\/internal\/analysis\/(scan|morph-scan|morph-model)\.mjs$/.test(url) || /\/ts-morph\/dist\/ts-morph\.js$/.test(url)) {
    fs.appendFileSync(process.env.FISH_ANALYSIS_LOAD_LOG, JSON.stringify({ pid: process.pid, url }) + '\n');
  }
  return next(url, context);
} });
