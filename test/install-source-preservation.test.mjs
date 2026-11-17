import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'

const install=process.env.FISH_TEST_INSTALL_ROOT
if(!install)throw Error('FISH_TEST_INSTALL_ROOT must be an isolated installed package')
const load=file=>import(pathToFileURL(join(install,'node_modules/fish-body',file)))
const {createMarketBodyAdapter}=await load('internal/backend/lib/market-runtime.mjs')
const {withStateConfig}=await load('internal/backend/production-state.mjs')
const {ProfileData}=await load('internal/profile-data.js')
const {configureBackend}=await load('internal/backend-entry.js')
const root=fs.mkdtempSync(join(tmpdir(),'source-preservation-'))
let sequence=0
function fixture({repair=false,capability=1,name='ordinary-plugin'}={}){
 const dir=join(root,'profiles',String(++sequence));fs.mkdirSync(dir,{recursive:true})
 fs.writeFileSync(join(dir,'package.json'),JSON.stringify({private:true,dependencies:{'fish-body':'fixture'},dsh:{profile:{bundles:['fish-body']}}}))
 const dataRoot=join(root,'data-'+sequence);fs.mkdirSync(dataRoot)
 const data=new ProfileData(dir,'body');data.initialize({root:dataRoot})
 const config=configureBackend(data.state())
 const archive=join(root,'original-'+sequence+'.tgz'),baseline=archive+'.bytes';fs.writeFileSync(archive,'fixed-acquired-fixture');fs.copyFileSync(archive,baseline)
 const original={archive,baseline,requestedSpec:'github:fixture/plugin#candidate',pinnedCommit:'a'.repeat(40),packageName:name,version:'1.0.0'}
 const ready={original,packageName:name,version:'1.0.0'}
 let calls=[]
 const adapter=withStateConfig(config,()=>createMarketBodyAdapter({profileDir:dir,sourcePreservationVersion:capability,
  prepare:async()=>repair?{prepared:[ready],resolutions:[]}:ready}))
 const deploy=async(args,options)=>{
  calls.push({args,options});fs.mkdirSync(join(dir,'node_modules',name),{recursive:true})
  fs.writeFileSync(join(dir,'node_modules',name,'package.json'),JSON.stringify({name,version:'1.0.0'}))
  return {exitCode:0,sourcePreservation:[{requestedSpec:original.requestedSpec}]}
 }
 return {original,calls,run:args=>withStateConfig(config,()=>adapter.run({args,deploy}))}
}
for(const name of ['ordinary-plugin','fish-body'])test('normal installation forwards fixed content and original source: '+name,async()=>{
 const f=fixture({name}),r=await f.run(['add',f.original.requestedSpec]);assert.equal(r.exitCode,0,r.stderr)
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].options.fixedPackageSources,[f.original])
 assert(f.calls[0].args.includes('file:'+f.original.archive))
})
test('repair forwards every fixed original using the same native source contract',async()=>{
 const f=fixture({repair:true}),r=await f.run(['install']);assert.equal(r.exitCode,0,r.stderr)
 assert.deepEqual(f.calls[0].options.fixedPackageSources,[f.original]);assert.equal(f.calls.length,1)
})
test('missing native capability refuses source loss before deployment',async()=>{
 const f=fixture({capability:0}),r=await f.run(['add',f.original.requestedSpec]);assert.equal(r.exitCode,1)
 assert.equal(r.refusalCode,'FH_SOURCE_PRESERVATION_UNAVAILABLE');assert.equal(f.calls.length,0)
})
test('changed acquired archive is refused before native deployment',async()=>{
 const f=fixture();fs.appendFileSync(f.original.archive,'tamper')
 const r=await f.run(['add',f.original.requestedSpec]);assert.equal(r.exitCode,1);assert.equal(f.calls.length,0)
})
