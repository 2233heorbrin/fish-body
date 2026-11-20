// C 职责：用 ui-scenarios 扁平夹具验证 v1.1 各接口 state 分支的契约形状。
// 独立运行，不依赖日常数据、不联网、不切插件。夹具即 B harness 读的同一套文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, 'fixtures', 'ui-scenarios');
function fx(name) {
  const p = join(FX, name + '.json');
  assert.ok(existsSync(p), `夹具缺失：${name}.json`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ---------- overview ----------

test('overview：normal 三项 ok，state 合法，字段齐全', () => {
  const f = fx('overview.normal');
  assert.equal(f.response.ok, true);
  assert.equal(f.response.items.length, 3);
  for (const it of f.response.items) {
    for (const k of ['key', 'title', 'summary', 'state', 'href']) assert.ok(k in it, `overview item 缺 ${k}`);
    assert.ok(['rice', 'stomach', 'hand'].includes(it.key));
    assert.ok(['empty', 'ok', 'partial', 'error'].includes(it.state));
  }
});

test('overview：empty 全部 empty，error 局部失败不牵连 ok 项', () => {
  const empty = fx('overview.empty').response.items;
  assert.ok(empty.every((it) => it.state === 'empty'));
  const err = fx('overview.error').response.items;
  assert.ok(err.some((it) => it.state === 'error'));
  assert.ok(err.some((it) => it.state === 'ok'), '局部失败时其他项保持 ok');
  const rec = fx('overview.recover').response.items;
  assert.ok(rec.every((it) => it.state === 'ok'));
});

// ---------- sources ----------

test('sources：normal/recover 字段齐全且 sourceType 合法，查询不含下载安装字段', () => {
  for (const name of ['sources.normal', 'sources.recover']) {
    const f = fx(name);
    assert.equal(f.response.ok, true);
    for (const it of f.response.items) {
      for (const k of ['id', 'name', 'sourceType', 'localVersion', 'description', 'path', 'hasRemote']) {
        assert.ok(k in it, `${name} item 缺 ${k}`);
      }
      assert.ok(['github', 'npm', 'local', 'unknown'].includes(it.sourceType));
      assert.equal(typeof it.hasRemote, 'boolean');
    }
  }
  assert.ok(!('downloaded' in fx('sources.normal').response.items[0]));
});

test('sources：error 返回 ok:false + 中文原因 + 空 items', () => {
  const r = fx('sources.error').response;
  assert.equal(r.ok, false);
  assert.ok(r.error && r.error.message);
  assert.deepEqual(r.items, []);
});

// ---------- check-version（v1.1 comparison） ----------

const CV_NAMES = ['check-version.normal', 'check-version.incomparable', 'check-version.historical', 'check-version.unavailable', 'check-version.error', 'check-version.recover'];

test('check-version：六份夹具 result 字段齐全，state/comparison 枚举合法', () => {
  for (const name of CV_NAMES) {
    const r = fx(name).response.result;
    for (const k of ['id', 'localVersion', 'remoteVersion', 'source', 'checkedAt', 'lastSuccessAt', 'state', 'comparison', 'reason']) {
      assert.ok(k in r, `${name} result 缺 ${k}`);
    }
    assert.ok(['ok', 'incomparable', 'unavailable', 'error', 'historical'].includes(r.state), `${name} state 非法`);
    assert.ok(['newer', 'same', 'local-newer', 'unknown'].includes(r.comparison), `${name} comparison 非法`);
  }
});

test('check-version：非 ok 态 comparison 必为 unknown（前端不做字符串比较）', () => {
  for (const name of CV_NAMES) {
    const r = fx(name).response.result;
    if (r.state !== 'ok') assert.equal(r.comparison, 'unknown', `${name} 非 ok 态 comparison 必须 unknown`);
  }
  assert.equal(fx('check-version.normal').response.result.comparison, 'newer', 'ok 态后端给出真实比较');
  assert.equal(fx('check-version.recover').response.result.comparison, 'same', '恢复 ok 态比较有效');
});

test('check-version：historical 带 lastSuccessAt 且标历史未确认，checkedAt 与 lastSuccessAt 分开', () => {
  const h = fx('check-version.historical').response.result;
  assert.equal(h.state, 'historical');
  assert.ok(h.lastSuccessAt && h.checkedAt);
  assert.notEqual(h.checkedAt, h.lastSuccessAt);
  assert.match(h.reason, /历史结果/);
  assert.match(h.reason, /未确认/);
  const e = fx('check-version.error').response.result;
  assert.ok(e.lastSuccessAt, 'error 态保留上次成功时间');
  assert.equal(e.comparison, 'unknown');
});

// ---------- plugin-switch（GET 九字段 + 缺口证据 + POST） ----------

const READONLY_KEYS = ['pluginId', 'nativeId', 'installed', 'enabled', 'runtime', 'registered', 'source', 'message'];
const READONLY_STATES = ['normal', 'unverified', 'recover'];

test('plugin-switch：正常/未验证/恢复 GET 顶层 {ok:true,items:[九字段]}，三者分开', () => {
  for (const st of READONLY_STATES) {
    const f = fx(`plugin-switch.${st}`);
    assert.equal(f.response.ok, true, `${st} 顶层 ok`);
    assert.ok(Array.isArray(f.response.items) && f.response.items.length > 0);
    for (const it of f.response.items) {
      for (const k of READONLY_KEYS) assert.ok(k in it, `plugin-switch.${st} item 缺 ${k}`);
      assert.equal(typeof it.installed, 'boolean');
      assert.ok(it.enabled === true || it.enabled === false || it.enabled === null, 'enabled 三态');
      assert.ok(['unknown', 'running', 'stopped', 'error'].includes(it.runtime));
      assert.equal(typeof it.registered, 'boolean');
    }
  }
});

test('plugin-switch：unverified 登记≠运行——enabled:null + runtime:unknown + registered:true', () => {
  const items = fx('plugin-switch.unverified').response.items;
  const u = items.find((it) => it.pluginId === 'demo-unverified-plugin');
  assert.ok(u);
  assert.equal(u.enabled, null);
  assert.equal(u.runtime, 'unknown');
  assert.equal(u.registered, true);
  assert.match(u.message, /不等于/);
});

test('plugin-switch：正常态 enabled:true 或 false 也不得把 runtime 写成健康伪造文案', () => {
  for (const it of fx('plugin-switch.normal').response.items) {
    if (it.runtime === 'unknown') assert.ok(!/正常|健康/.test(it.message), 'unknown 不得写健康文案');
  }
  const u = fx('plugin-switch.normal').response.items.find((it) => it.enabled === false);
  assert.ok(u && u.runtime === 'stopped');
});

test('plugin-switch：缺口顶层 ok:false + error.code + message + evidence（查过的位置）', () => {
  const f = fx('plugin-switch.error');
  assert.equal(f.response.ok, false);
  assert.equal(f.response.error.code, 'native-api-unavailable');
  assert.ok(f.response.error.message);
  assert.ok(Array.isArray(f.response.error.evidence) && f.response.error.evidence.length >= 5);
  for (const e of f.response.error.evidence) assert.ok(e.location && e.finding);
  const evidenceText = f.response.error.evidence.map((e) => e.location).join('|');
  assert.match(evidenceText, /body-switch|index\.js|plugin-manager/);
});

test('plugin-switch：POST 成功样例 state on/off、文案写明需刷新只读入口、不称运行正常', () => {
  for (const name of ['plugin-switch.normal', 'plugin-switch.recover', 'plugin-switch.unverified']) {
    const post = fx(name).postResult;
    assert.equal(post.ok, true);
    const r = post.result;
    for (const k of ['pluginId', 'requested', 'state', 'message']) assert.ok(k in r);
    assert.ok(['on', 'off', 'error'].includes(r.state));
    assert.match(r.message, /刷新只读状态入口确认/);
    assert.match(r.message, /不代表运行正常/);
  }
});

test('plugin-switch：POST 缺口样例 error.code + evidence', () => {
  const post = fx('plugin-switch.error').postResult;
  assert.equal(post.ok, false);
  assert.equal(post.error.code, 'native-api-unavailable');
  assert.ok(Array.isArray(post.error.evidence) && post.error.evidence.length > 0);
});

// ---------- sections（五项，保留原 ID） ----------

test('sections：五项固定顺序，rice/stomach/hand 原 ID 与 path 保留，overview/settings path:null', () => {
  const s = fx('sections.normal').response.sections;
  assert.deepEqual(s.map((x) => x.id), ['overview', 'rice', 'stomach', 'hand', 'settings']);
  for (const it of s) for (const k of ['id', 'title', 'description', 'path']) assert.ok(k in it);
  const byId = Object.fromEntries(s.map((x) => [x.id, x]));
  assert.ok(byId.rice.path && byId.stomach.path && byId.hand.path);
  assert.equal(byId.overview.path, null);
  assert.equal(byId.settings.path, null);
});
