import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
const install=process.env.FISH_TEST_INSTALL_ROOT,anchor=process.env.FISH_DSH_TEST_ANCHOR
if(!install||!anchor)throw Error('Provide installed candidate and isolated DSH anchor')
const load=file=>import(pathToFileURL(join(install,'node_modules/fish-body',file)))
const {bodyProfileData}=await load('internal/body-data.js'),{createInstallTransaction}=await load('internal/install-transaction.js')
const temp=fs.mkdtempSync(join(tmpdir(),'body-consumers-'))
const dir=name=>{const path=join(temp,name);fs.mkdirSync(path,{recursive:true});return path}
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value))
const profile=name=>{const path=dir(name);save(join(path,'package.json'),{name,private:true,dsh:{profile:{bundles:[]}}});return path}
test('native composed old fishRoot migrates before UI initialization; shared conflicts stay visible',()=>{
 const path=profile('legacy'),root=dir('legacy-root'),ctx={dir:path,installAnchor:anchor}
 fs.writeFileSync(join(path,'cordis.patch.yml'),JSON.stringify([{insert:[{id:'fish-body',name:'unused',config:{fishRoot:root}}]}]))
 const data=bodyProfileData(ctx);assert.equal(data.state().root,root);assert.equal(data.state().status,'pending-initialization')
 const adapter=createInstallTransaction(ctx);assert.equal(typeof adapter.run,'function')
 assert.equal(data.state().status,'ready');assert.equal(JSON.parse(fs.readFileSync(join(path,'fish-body-state.json'))).frameworkRoot,root)
 const conflicting=profile('conflict'),other=dir('other-root')
 save(join(conflicting,'fish-data.json'),{schema:'fish-profile-data/v1',root,components:['body']})
 fs.writeFileSync(join(conflicting,'cordis.patch.yml'),JSON.stringify([{insert:[{id:'fish-body',name:'unused',config:{fishRoot:other}}]}]))
 assert.match(bodyProfileData({dir:conflicting,installAnchor:anchor}).state().error,/FISH_BINDING_CONFLICT/)
 assert(!fs.existsSync(join(conflicting,'fish-body-data.json')))
})
test('saved backend root is a legacy input, independent binding wins and stale transactions refuse work',async()=>{
 const path=profile('backend'),root=dir('backend-root'),other=dir('backend-other'),ctx={dir:path,installAnchor:anchor}
 save(join(path,'fish-body-state.json'),{frameworkRoot:root})
 const data=bodyProfileData(ctx);data.initialize();assert.equal(data.state().root,root)
 save(join(path,'fish-data.json'),{schema:'fish-profile-data/v1',root:other,components:['brain','body']})
 const adapter=createInstallTransaction(ctx)
 assert.equal(JSON.parse(fs.readFileSync(join(path,'fish-body-state.json'))).frameworkRoot,root)
 data.initialize({root:other,switchRoot:true})
 const result=await adapter.run({args:['add','synthetic-never-deploy']})
 assert.equal(result.exitCode,1);assert.equal(result.wroteNothing,true);assert.match(result.stderr,/FH_ROOT_RELOAD_REQUIRED/)
 assert.equal(JSON.parse(fs.readFileSync(join(path,'fish-body-state.json'))).frameworkRoot,root,'old factory cannot switch live backend')
 const next=createInstallTransaction(ctx);assert.equal(typeof next.run,'function')
 assert.equal(JSON.parse(fs.readFileSync(join(path,'fish-body-state.json'))).frameworkRoot,other)
 fs.renameSync(other,other+'-moved')
 const unavailable=await next.run({args:['add','synthetic-never-deploy']})
 assert.equal(unavailable.exitCode,1);assert.equal(unavailable.wroteNothing,true);assert.match(unavailable.stderr,/FISH_DATA_NOT_READY: invalid-root/)
})
test('invalid independent data is an explicit transaction failure, not fallback',async()=>{
 const path=profile('invalid'),root=dir('invalid-old')
 save(join(path,'fish-data.json'),{schema:'fish-profile-data/v1',root,components:['body']});fs.writeFileSync(join(path,'fish-body-data.json'),'{bad')
 const result=await createInstallTransaction({dir:path,installAnchor:anchor}).run({args:['add','synthetic-never-deploy']})
 assert.equal(result.exitCode,1);assert.equal(result.wroteNothing,true);assert.match(result.stderr,/FISH_BINDING_INVALID/)
 assert(!fs.existsSync(join(path,'fish-body-state.json')))
})
test('late bundled SHA activation cannot register on a disposed native owner',async()=>{
 const {activateRuntimePlugin}=await load('internal/runtime-gate.js');let registrations=0
 const dispose=await activateRuntimePlugin({fiber:{uid:null,state:4},tools:{register(){registrations++}}})
 assert.equal(typeof dispose,'function');assert.equal(registrations,0)
})
