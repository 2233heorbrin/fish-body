import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const anchor = process.env.FISH_DSH_TEST_ANCHOR, install = process.env.FISH_TEST_INSTALL_ROOT
if (!anchor || !install) throw new Error('Provide isolated official DSH anchor and installed tarball root')
const req = createRequire(anchor), mod = id => req('@deepseek-ai/' + id), { Context } = mod('cordis')
const root = join(install, 'node_modules/fish-body'), load = path => import(pathToFileURL(join(root, path)))
const temp = mkdtempSync(join(tmpdir(), 'fish-body-native-'))

test('installed body mounts backend and SHA, scopes two Profiles and drains exact operations on native disposal', async () => {
  const fixtures = []
  async function fixture(id) {
    const profileDir = join(temp, id), workspace = join(temp, id + '-data'); mkdirSync(profileDir); mkdirSync(workspace)
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: id, private: true, dependencies: { 'fish-body': 'file:artifact' }, dsh: { profile: { bundles: ['fish-body'] } } }))
    const ctx = new Context().extend({ baseUrl: pathToFileURL(anchor).href }), errors = [], routes = new Map(), opened = []
    ctx.logger.exporter({ levels: { default: 1 }, export: entry => { if (entry.type === 'error') errors.push(entry.args.map(String).join(' ')) } })
    ctx.provide('profileContext', { dir: profileDir, installAnchor: anchor })
    ctx.provide('sessionController', { openWorkspacePath: async ({ path }) => { opened.push(path) } })
    ctx.provide('connection', { fetch: { register(row) { routes.set(row.path, row); return () => routes.delete(row.path) } } })
    const fibers = []
    for (const name of ['cordis-plugin-loader', 'dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools']) {
      const value = mod(name), fiber = ctx.plugin(value.default || value, {}); await fiber.await(); fibers.push(fiber); assert.equal(fiber.state, 2, errors.join('; '))
    }
    const independent = ctx.tools.register({ name: 'independent_tool', description: 'separate plugin', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({ independent: true }) })
    const plugin = ctx.plugin(await load('index.js'), {}); await plugin.await(); assert.equal(plugin.state, 2, errors.join('; '))
    const fetch = async (path, body) => routes.get(path).fetch(new Request('http://local' + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }))
    const current = await (await fetch('/api/fish-body/data')).json(); assert.equal(current.status, 'pending-workspace')
    const ready = await (await fetch('/api/fish-body/data', { action: 'select', path: workspace })).json()
    assert.equal(ready.status, 'ready'); assert.equal(ready.dependencies.status, 'host-blocked'); assert.equal(ready.dependencies.backend, 'bundled')
    assert(routes.has('/api/fish-hand/pending')); assert(ctx.tools.get('fish_hand'))
    // The injected SHA mount performs asynchronous realpath/readFile before registration.
    for (let attempt = 0; !ctx.tools.get('utility_sha256') && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    assert(ctx.tools.get('utility_sha256'), errors.join('; '))
    const hash = await ctx.tools.get('utility_sha256').execute({ text: 'abc' }); assert.match(JSON.stringify(hash), /ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad/)
    await fetch('/api/fish-body/data/open', { section: 'rice' }); assert.deepEqual(opened, [join(workspace, '饭')])
    const value = { ctx, plugin, fibers, profileDir, workspace, routes, errors, independent, fetch }; fixtures.push(value); return value
  }
  try {
    const a = await fixture('profile-a'), b = await fixture('profile-b')
    const state = await load('internal/backend/production-state.mjs')
    const result = await Promise.all([a, b].map((f, index) => state.withStateConfig(join(f.profileDir, 'fish-body-state.json'), async () => {
      await new Promise(resolve => setTimeout(resolve, index ? 1 : 5)); return state.loadProductionState().defaultProfileDir
    })))
    assert.deepEqual(result, [a.profileDir, b.profileDir])
    const phase = await load('internal/backend/lib/body-switch.mjs'), started = Promise.withResolvers(), finish = Promise.withResolvers()
    const operation = phase.withBodyOperation(a.profileDir, async () => { started.resolve(); await finish.promise })
    await started.promise
    let disposed = false; const disposal = a.plugin.dispose().then(() => { disposed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposed, false); assert.equal(phase.readBodyPhase({ profileDir: a.profileDir }).phase, 'closing')
    finish.resolve(); await operation; await disposal; await a.plugin.await()
    assert(!a.ctx.tools.get('utility_sha256')); assert(!a.ctx.tools.get('fish_hand'))
    assert(a.ctx.tools.get('independent_tool')); assert(b.ctx.tools.get('utility_sha256')); assert(b.routes.has('/api/fish-body/data'))
    assert.equal(a.routes.size, 0); assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, [])
    const nextRoot = join(temp, 'new-body-data'); mkdirSync(nextRoot)
    const switched = await (await b.fetch('/api/fish-body/data', { action: 'select', path: nextRoot })).json()
    assert.equal(switched.root, nextRoot); assert.equal(switched.dependencies.status, 'restart-required')
    const rejected = await b.fetch('/api/fish-hand/status')
    assert.equal(rejected.status, 409); assert.match(JSON.stringify(await rejected.json()), /FH_ROOT_RELOAD_REQUIRED/)
    assert.throws(() => b.ctx.tools.get('fish_hand').execute({ action: 'status' }), /FH_ROOT_RELOAD_REQUIRED/)
    assert.equal(JSON.parse(readFileSync(join(b.profileDir, 'fish-body-state.json'), 'utf8')).frameworkRoot, b.workspace)
  } finally {
    for (const f of fixtures.reverse()) {
      await f.plugin.dispose(); await f.plugin.await(); f.independent()
      for (const fiber of f.fibers.reverse()) { await fiber.dispose(); await fiber.await() }
    }
  }
})
