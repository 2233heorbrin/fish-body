import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const install = process.env.FISH_TEST_INSTALL_ROOT
if (!install) throw new Error('FISH_TEST_INSTALL_ROOT must point to an isolated installed tarball')
const root = join(install, 'node_modules', 'fish-body')
const { ProfileData, conversationWorkspace, mountProfileData } = await import(pathToFileURL(join(root, 'internal/profile-data.js')))
const temp = mkdtempSync(join(tmpdir(), 'fish-data-test-'))
const directory = name => { const path = join(temp, name); mkdirSync(path, { recursive: true }); return path }
const data = (name, component = 'brain', options) => new ProfileData(directory(name), component, options)

test('no workspace stays pending and never uses cwd', () => {
  const value = data('pending'); assert.equal(value.initialize().status, 'pending-workspace')
  assert(!existsSync(value.file)); assert.equal(conversationWorkspace({ get: () => null }, 'unknown'), null)
})
test('only explicitly addressed native workspace is used', () => {
  const first = directory('workspace-a'), second = directory('workspace-b')
  const ctx = { get: name => name === 'workspaceRegistry' ? { list: () => [{ path: first, sessionIds: ['a'] }, { path: second, sessionIds: ['b'] }] } : null }
  assert.equal(conversationWorkspace(ctx, 'b'), second)
  assert.equal(conversationWorkspace(ctx, 'missing'), null)
  const value = data('current'); value.initialize({ root: conversationWorkspace(ctx, 'b') }); assert.equal(value.state().root, second)
})
for (const order of [['brain', 'body'], ['body', 'brain']]) test('independent binding order ' + order.join(' -> '), () => {
  const profile = directory(order.join('-')), first = new ProfileData(profile, order[0]), second = new ProfileData(profile, order[1])
  const selected = directory(order.join('-') + '-root'), other = directory(order.join('-') + '-other')
  first.initialize({ root: selected }); second.initialize({ root: other })
  assert.equal(first.state().root, selected); assert.equal(second.state().root, other)
  assert.deepEqual(new ProfileData(profile, 'brain').binding().components, ['brain'])
  assert(existsSync(join(first.component === 'body' ? selected : other, '饭'))); assert(existsSync(join(first.component === 'brain' ? selected : other, '鱼的大脑', '人格', 'generated', 'SELF.compat.md')))
})
test('workspace changes do not move data; explicit root switch preserves old files and persists', () => {
  const value = data('switch'), first = directory('switch-first'), next = directory('switch-next')
  value.initialize({ root: first }); writeFileSync(join(first, 'kept.txt'), 'kept')
  value.initialize({ root: next }); assert.equal(value.state().root, first)
  value.initialize({ root: next, switchRoot: true }); assert.equal(value.state().root, next)
  assert.equal(readFileSync(join(first, 'kept.txt'), 'utf8'), 'kept')
  assert(!existsSync(join(next, 'kept.txt')))
  assert.equal(new ProfileData(value.profileDir, 'brain').state().root, next)
})
test('valid legacy content is preserved and invalid legacy path is visible, never replaced', () => {
  const legacy = directory('legacy'), value = data('legacy-profile', 'brain', { legacyRoot: legacy })
  const self = join(legacy, '鱼的大脑', '人格', 'generated', 'SELF.compat.md'); mkdirSync(join(self, '..'), { recursive: true }); writeFileSync(self, 'SYNTHETIC_SELF')
  value.initialize(); assert.equal(readFileSync(self, 'utf8'), 'SYNTHETIC_SELF')
  const invalid = join(temp, 'missing-legacy'), broken = data('broken', 'body', { legacyRoot: invalid })
  assert.equal(broken.state().root, invalid); assert.equal(broken.state().status, 'invalid-root')
  assert.throws(() => broken.initialize({ root: legacy }), /FISH_ROOT_INVALID/); assert(!existsSync(invalid))
})
