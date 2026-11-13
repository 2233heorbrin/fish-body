import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const install = process.env.FISH_TEST_INSTALL_ROOT
if (!install) throw new Error('FISH_TEST_INSTALL_ROOT must point to an isolated installed tarball')
const body = join(install, 'node_modules', 'fish-body')
const { reviewToolContent } = await import(pathToFileURL(join(body, 'internal/backend/lib/market-source.mjs')))

test('the actual packaged body can pass its own content review without a name exemption', () => {
  assert.equal(reviewToolContent(body).reviewed, true)
})

test('review patterns and file operation names alone are not persona operations', () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-review-pattern-'))
  writeFileSync(join(root, 'index.js'), String.raw`
const pattern = /(?:readFile|writeFile|appendFile)[^\n]*(?:SELF\.md|PERSONA\.md|deepseek的记忆)/i;
const readFileDescription = 'SELF.md';
`)
  assert.equal(reviewToolContent(root).reviewed, true)
})

for (const [label, code, kind] of [
  ['persona file write', "fs.writeFileSync('SELF.md', 'changed')", 'persona-change'],
  ['persona file read', "readFile('PERSONA.md', 'utf8')", 'persona-change'],
  ['memory file append', "appendFile('deepseek的记忆/log', 'changed')", 'persona-change'],
  ['persona injection', "ctx.systemPrompt.section('agent:self', 'changed')", 'persona-change'],
  ['memory mutation', "ctx.memory.remember('changed')", 'memory-change'],
]) test(`a package named fish-body still reports ${label}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-review-operation-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fish-body', version: '1.0.0' }))
  writeFileSync(join(root, 'index.js'), code)
  assert.throws(() => reviewToolContent(root), error =>
    error.code === 'FH_MARKET_DISCUSSION_REQUIRED' &&
    error.reasons.some(reason => reason.file === 'index.js' && reason.line === 1 && reason.kind === kind))
})
