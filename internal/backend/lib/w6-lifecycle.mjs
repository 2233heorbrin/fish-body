/** One approved lifecycle event using the already installed npm script runner.
 * No install, dependency resolution, auto pre/post hooks or arbitrary command API.
 */
import {readFileSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';

const input=JSON.parse(readFileSync(0,'utf8'));
const {hook,script,cwd,root}=input;
const allowed=['preinstall','install','postinstall','prepare','prebuild','build','postbuild','prepack'];
if(!allowed.includes(hook)||typeof script!=='string')throw new Error('PKG_LIFECYCLE_INVALID');
const pkg=JSON.parse(readFileSync(join(cwd,'package.json'),'utf8'));
const implicit=hook==='install'&&script==='node-gyp rebuild'&&!pkg.scripts?.install&&!pkg.scripts?.preinstall
  &&pkg.gypfile!==false&&existsSync(join(cwd,'binding.gyp'));
if(pkg.scripts?.[hook]!==script&&!implicit)throw new Error('PKG_LIFECYCLE_CHANGED');
const localRequire=createRequire(import.meta.url);
const npmRoot=dirname(localRequire.resolve('npm/package.json'));
const require=createRequire(join(npmRoot,'package.json'));
const runScript=require('@npmcli/run-script');
try {
  await runScript({event:hook,path:cwd,pkg,cmd:script,stdio:'pipe',
    env:{INIT_CWD:root,npm_execpath:join(npmRoot,'bin/npm-cli.js'),npm_node_execpath:process.execPath,
      npm_command:'run-script',npm_config_ignore_scripts:'true',CI:'true',HUSKY:'0'}});
}catch{process.stderr.write('PKG_LIFECYCLE_FAILED\n');process.exitCode=1;}
