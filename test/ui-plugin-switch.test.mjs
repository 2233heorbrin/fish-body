// C 职责：plugin-switch.mjs 契约级测试（node:test）。缺口分支与真实桥接分支都覆盖。
// 独立运行，不依赖日常数据、不联网、不切日常插件、不读写 Profile。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_BRIDGE_SLOT,
  NATIVE_API_PROBE,
  classifyPluginTarget,
  isNativeSwitchAvailable,
  readPluginSwitchState,
  setPluginSwitch,
} from '../internal/backend/lib/plugin-switch.mjs';

function clearBridge() {
  try { delete globalThis[NATIVE_BRIDGE_SLOT]; } catch { /* noop */ }
}
function setBridge(bridge) {
  globalThis[NATIVE_BRIDGE_SLOT] = bridge;
}
async function withBridge(bridge, fn) {
  clearBridge();
  setBridge(bridge);
  try { return await fn(); } finally { clearBridge(); }
}

const READONLY_KEYS = ['pluginId', 'nativeId', 'installed', 'enabled', 'runtime', 'registered', 'source', 'message'];
const RESULT_KEYS = ['pluginId', 'requested', 'state', 'message'];

// ---------- 缺口分支（默认宿主状态）----------

test('缺口：isNativeSwitchAvailable 为 false', () => {
  clearBridge();
  assert.equal(isNativeSwitchAvailable(), false);
});

test('缺口：read 返回九字段且三态分开、带核查证据', async () => {
  clearBridge();
  const r = await readPluginSwitchState('demo.plugin');
  for (const k of READONLY_KEYS) assert.ok(k in r, `缺字段 ${k}`);
  assert.equal(r.code, 'native-api-unavailable');
  assert.equal(r.enabled, null, '原生启用选择不明必须是 null');
  assert.equal(r.runtime, 'unknown', '无证据运行反馈必须是 unknown');
  assert.equal(r.installed, false);
  assert.equal(r.registered, false);
  assert.ok(Array.isArray(r.evidence) && r.evidence.length >= 5, '缺口须列具体核查证据');
  for (const e of r.evidence) {
    assert.ok(e.location && e.finding, '每条证据含位置与判定理由');
  }
  assert.match(r.message, /不等于已安装|不等于已挂载/);
});

test('缺口：set 返回 error + native-api-unavailable，不称运行正常', async () => {
  clearBridge();
  const r = await setPluginSwitch('demo.plugin', true);
  for (const k of RESULT_KEYS) assert.ok(k in r, `缺字段 ${k}`);
  assert.equal(r.state, 'error');
  assert.equal(r.code, 'native-api-unavailable');
  assert.equal(r.requested, true);
  assert.ok(Array.isArray(r.evidence) && r.evidence.length >= 5);
  assert.match(r.message, /未提交/);
});

test('缺口证据常量自洽：available=false 且 evidence 非空', () => {
  assert.equal(NATIVE_API_PROBE.available, false);
  assert.ok(NATIVE_API_PROBE.evidence.length >= 5);
  assert.ok(NATIVE_API_PROBE.attachRequirement.length > 0);
});

// ---------- 身份映射纯逻辑 ----------

test('身份映射：正常 id 通过并给 nativeId', () => {
  assert.deepEqual(classifyPluginTarget('demo.plugin'), { ok: true, nativeId: 'demo.plugin' });
  assert.deepEqual(classifyPluginTarget('  demo.plugin  '), { ok: true, nativeId: 'demo.plugin' });
});
test('身份映射：空/异常形状 id 被拒', () => {
  assert.equal(classifyPluginTarget('').reason, 'empty-id');
  assert.equal(classifyPluginTarget(null).reason, 'empty-id');
  assert.equal(classifyPluginTarget('脑/插件').reason, 'unmappable-id');
});

test('身份映射：名字含 brain/body/sha256 不再因名字被拒（按真实归属判定）', () => {
  for (const id of ['fish-body', 'fish-brain.x', 'utility.sha256', 'brain.plugin', 'body-tools']) {
    assert.deepEqual(classifyPluginTarget(id), { ok: true, nativeId: id }, `不应按名字拒绝 ${id}`);
  }
});

// ---------- 已接桥接：真实路径（fake bridge，不切日常插件）----------

const okBridgeRead = {
  nativeId: 'demo.plugin@1.2.3',
  installed: true,
  enabled: false,
  runtime: 'unknown',
  registered: true,
  source: 'demo.plugin',
  message: '已读宿主接口',
};

test('已接桥接：isNativeSwitchAvailable 为 true', async () => {
  await withBridge({ readState: async () => okBridgeRead, setEnabled: async () => ({ ok: true }) }, () => {
    assert.equal(isNativeSwitchAvailable(), true);
  });
});

test('已接桥接：read 归一化 enabled 三态 / runtime 四态分开', async () => {
  const cases = [
    [{ ...okBridgeRead, enabled: true, runtime: 'running' }, true, 'running'],
    [{ ...okBridgeRead, enabled: false, runtime: 'stopped' }, false, 'stopped'],
    [{ ...okBridgeRead, enabled: null, runtime: 'error' }, null, 'error'],
    [{ ...okBridgeRead, enabled: undefined, runtime: 'healthy' }, null, 'unknown'],
  ];
  for (const [raw, enabled, runtime] of cases) {
    await withBridge({ readState: async () => raw, setEnabled: async () => ({ ok: true }) }, async () => {
      const r = await readPluginSwitchState('demo.plugin');
      for (const k of READONLY_KEYS) assert.ok(k in r, `缺字段 ${k}`);
      assert.equal(r.enabled, enabled);
      assert.equal(r.runtime, runtime);
      assert.equal(r.installed, true);
      assert.equal(r.registered, true);
      assert.equal(r.nativeId, 'demo.plugin@1.2.3');
      assert.equal(r.code, undefined, '真实路径无缺口 code');
      assert.match(r.message, /不等于已安装或挂载/);
    });
  }
});

test('已接桥接：read 对宿主只读/内置归属在 message 体现，installed 按真实值', async () => {
  await withBridge({
    readState: async () => ({ ...okBridgeRead, readOnlyReason: '宿主内置不可独立开关' }),
    setEnabled: async () => ({ ok: true }),
  }, async () => {
    const r = await readPluginSwitchState('utility.sha256');
    assert.match(r.message, /只读|内置/);
    assert.match(r.message, /宿主内置不可独立开关/);
    assert.equal(r.installed, true, 'installed 按宿主真实值，不受名字影响');
  });
});

test('已接桥接：read 失败返回 read-state-failed，enabled=null/runtime=unknown', async () => {
  await withBridge({ readState: async () => { throw new Error('boom'); }, setEnabled: async () => ({ ok: true }) }, async () => {
    const r = await readPluginSwitchState('demo.plugin');
    assert.equal(r.code, 'read-state-failed');
    assert.equal(r.enabled, null);
    assert.equal(r.runtime, 'unknown');
    assert.match(r.message, /boom/);
  });
});

test('已接桥接：宿主真实归属 readOnlyReason 拒绝，不按名字猜 brain/body', async () => {
  let setCalled = 0;
  await withBridge({
    readState: async () => ({ ...okBridgeRead, readOnlyReason: '内置组件，不可独立开关' }),
    setEnabled: async () => { setCalled++; return { ok: true }; },
  }, async () => {
    const r = await setPluginSwitch('ordinary.plugin', true);
    assert.equal(r.code, 'read-only-component');
    assert.match(r.message, /只读|内置/);
    assert.equal(r.state, 'error');
    assert.equal(setCalled, 0, '只读/内置组件不提交开关');
  });
});

test('已接桥接：名字含 brain/body 的普通插件按真实 installed 可操作，不因名字被拒', async () => {
  let setArg = null;
  await withBridge({
    readState: async () => ({ ...okBridgeRead, nativeId: 'real.entry@2' }),
    setEnabled: async (id) => { setArg = id; return { ok: true }; },
  }, async () => {
    const r = await setPluginSwitch('brain.assistant.plugin', true);
    assert.equal(r.state, 'on');
    assert.equal(setArg, 'real.entry@2', '传给宿主的是解析后 nativeId，不是请求 pluginId');
  });
});

test('已接桥接：能否操作只看 installed，registered=false 不挡路', async () => {
  let setCalled = 0;
  await withBridge({
    readState: async () => ({ ...okBridgeRead, registered: false, installed: true }),
    setEnabled: async () => { setCalled++; return { ok: true }; },
  }, async () => {
    const r = await setPluginSwitch('demo.plugin', true);
    assert.equal(r.state, 'on', 'installed=true 即可放行，registered 只是手登记');
    assert.equal(setCalled, 1);
  });
});

test('已接桥接：未安装条目（installed=false，即便 registered=true）被拒且不提交', async () => {
  let setCalled = 0;
  await withBridge({
    readState: async () => ({ ...okBridgeRead, registered: true, installed: false }),
    setEnabled: async () => { setCalled++; return { ok: true }; },
  }, async () => {
    const r = await setPluginSwitch('demo.plugin', true);
    assert.equal(r.code, 'not-installed');
    assert.equal(setCalled, 0, 'installed=false 时即便手登记也不提交');
  });
});

test('已接桥接：set 成功 state=on/off，文案写明需刷新只读状态入口且不称运行正常', async () => {
  for (const [enabled, state] of [[true, 'on'], [false, 'off']]) {
    await withBridge({ readState: async () => okBridgeRead, setEnabled: async () => ({ ok: true }) }, async () => {
      const r = await setPluginSwitch('demo.plugin', enabled);
      for (const k of RESULT_KEYS) assert.ok(k in r, `缺字段 ${k}`);
      assert.equal(r.state, state);
      assert.equal(r.requested, enabled);
      assert.match(r.message, /已提交/);
      assert.match(r.message, /刷新只读状态入口确认/);
      assert.match(r.message, /不代表运行正常/);
      assert.doesNotMatch(r.message, /^运行正常/);
    });
  }
});

test('已接桥接：set 请求失败返回 native-call-failed + 中文原因', async () => {
  await withBridge({
    readState: async () => okBridgeRead,
    setEnabled: async () => ({ ok: false, message: '宿主拒绝：插件只读' }),
  }, async () => {
    const r = await setPluginSwitch('demo.plugin', true);
    assert.equal(r.state, 'error');
    assert.equal(r.code, 'native-call-failed');
    assert.match(r.message, /宿主拒绝/);
  });
});

test('已接桥接：set 抛异常返回 native-call-failed，不假装成功', async () => {
  await withBridge({
    readState: async () => okBridgeRead,
    setEnabled: async () => { throw new Error('rpc-down'); },
  }, async () => {
    const r = await setPluginSwitch('demo.plugin', true);
    assert.equal(r.state, 'error');
    assert.equal(r.code, 'native-call-failed');
    assert.match(r.message, /rpc-down/);
  });
});

test('已接桥接：连续点击去重，同一目标仅提交一次', async () => {
  let resolveGate;
  const gate = new Promise((res) => { resolveGate = res; });
  let setCalls = 0;
  await withBridge({
    readState: async () => okBridgeRead,
    setEnabled: async () => { setCalls++; await gate; return { ok: true }; },
  }, async () => {
    const first = setPluginSwitch('demo.plugin', true);
    const second = await setPluginSwitch('demo.plugin', true);
    assert.equal(second.code, 'duplicate-in-flight', '在途重复点击被去重');
    resolveGate();
    const r1 = await first;
    assert.equal(r1.state, 'on');
    assert.equal(setCalls, 1, '桥接 setEnabled 只被调用一次');
  });
});

test('已接桥接：登记≠运行——registered=true 但 enabled=null/runtime=unknown 时 message 说明', async () => {
  await withBridge({
    readState: async () => ({ ...okBridgeRead, enabled: null, runtime: 'unknown', registered: true }),
    setEnabled: async () => ({ ok: true }),
  }, async () => {
    const r = await readPluginSwitchState('demo.plugin');
    assert.equal(r.registered, true);
    assert.equal(r.enabled, null);
    assert.equal(r.runtime, 'unknown');
    assert.match(r.message, /登记/);
    assert.match(r.message, /不等于已安装或挂载/);
  });
});

// ---------- #130：显式传桥，按 ctx 隔离，绝不借 global / 别的 ctx ----------

test('#130 显式传桥优先于 global：read/set 只用传入的桥，不读 global 槽', async () => {
  const explicitReads = [];
  const explicitSets = [];
  const explicitBridge = {
    readState: async (id) => { explicitReads.push(id); return { ...okBridgeRead, nativeId: 'explicit@1', installed: true }; },
    setEnabled: async (id) => { explicitSets.push(id); return { ok: true }; },
  };
  // global 槽放一个不同的桥：若被读到就会污染断言
  const globalBridge = {
    readState: async () => { throw new Error('global bridge 不应被调用'); },
    setEnabled: async () => { throw new Error('global bridge 不应被调用'); },
  };
  await withBridge(globalBridge, async () => {
    const r = await readPluginSwitchState('demo.plugin', explicitBridge);
    assert.equal(r.nativeId, 'explicit@1', 'read 用显式桥的结果，不是 global');
    assert.deepEqual(explicitReads, ['demo.plugin']);

    const s = await setPluginSwitch('demo.plugin', true, explicitBridge);
    assert.equal(s.state, 'on');
    assert.deepEqual(explicitSets, ['explicit@1'], 'set 用显式桥解析后的 nativeId');
  });
});

test('#130 显式传入的桥非活（isAlive=false）→ 自身缺口，绝不借 global', async () => {
  const globalBridge = {
    readState: async () => okBridgeRead,
    setEnabled: async () => ({ ok: true }),
  };
  const dead = {
    isAlive: () => false,
    readState: async () => { throw new Error('非活桥不该被调用'); },
    setEnabled: async () => { throw new Error('非活桥不该被调用'); },
  };
  await withBridge(globalBridge, async () => {
    const r = await readPluginSwitchState('demo.plugin', dead);
    assert.equal(r.code, 'native-api-unavailable');
    assert.match(r.message, /非活状态|已被新实例接管/);
    assert.match(r.message, /未借用 global/);
    assert.ok(Array.isArray(r.evidence) && r.evidence.length >= 5);

    const s = await setPluginSwitch('demo.plugin', true, dead);
    assert.equal(s.code, 'native-api-unavailable');
    assert.equal(s.state, 'error');
  });
});

test('#130 显式传 undefined（该 ctx 无桥）→ 自身缺口，不回退 global', async () => {
  const globalBridge = {
    readState: async () => okBridgeRead,
    setEnabled: async () => ({ ok: true }),
  };
  await withBridge(globalBridge, async () => {
    const r = await readPluginSwitchState('demo.plugin', undefined);
    assert.equal(r.code, 'native-api-unavailable', '显式传 undefined 不回退 global');
    const s = await setPluginSwitch('demo.plugin', true, undefined);
    assert.equal(s.code, 'native-api-unavailable');
  });
});

test('#130 isNativeSwitchAvailable 按传入桥判定，非活传桥为 false 不借 global', async () => {
  const globalBridge = { readState: async () => ({}), setEnabled: async () => ({ ok: true }) };
  await withBridge(globalBridge, async () => {
    const live = { readState: async () => ({}), setEnabled: async () => ({ ok: true }) };
    const dead = { isAlive: false, readState: async () => ({}), setEnabled: async () => ({ ok: true }) };
    assert.equal(isNativeSwitchAvailable(live), true);
    assert.equal(isNativeSwitchAvailable(dead), false, '非活传桥不借 global');
    assert.equal(isNativeSwitchAvailable(), true, '不传仍回退 global（旧探针兼容）');
  });
});

test('#130 A/B 两 ctx 并发同 ID：各自到本 ctx，互不误判重复、互不串桥', async () => {
  clearBridge();
  const aCalls = [], bCalls = [];
  const bridgeA = {
    readState: async () => ({ ...okBridgeRead, nativeId: 'same.id@A', installed: true }),
    setEnabled: async (id) => { aCalls.push(id); await Promise.resolve(); return { ok: true }; },
  };
  const bridgeB = {
    readState: async () => ({ ...okBridgeRead, nativeId: 'same.id@B', installed: true }),
    setEnabled: async (id) => { bCalls.push(id); await Promise.resolve(); return { ok: true }; },
  };
  // 同一 pluginId、同一 requested 并发提交，但桥不同 → 两个都成功，各自 nativeId
  const [ra, rb] = await Promise.all([
    setPluginSwitch('same.plugin', true, bridgeA),
    setPluginSwitch('same.plugin', true, bridgeB),
  ]);
  assert.equal(ra.state, 'on');
  assert.equal(rb.state, 'on');
  assert.notEqual(ra.code, 'duplicate-in-flight', 'A 不被 B 的在途误判');
  assert.notEqual(rb.code, 'duplicate-in-flight', 'B 不被 A 的在途误判');
  assert.deepEqual(aCalls, ['same.id@A']);
  assert.deepEqual(bCalls, ['same.id@B'], 'B 的 set 到 B 的桥，不串到 A');
  clearBridge();
});

test('#130 同一 ctx 同 ID 连续点击仍去重（按桥作用域隔离不破坏原去重）', async () => {
  clearBridge();
  let resolveGate;
  const gate = new Promise((res) => { resolveGate = res; });
  let calls = 0;
  const bridge = {
    readState: async () => ({ ...okBridgeRead, nativeId: 'dedupe@1', installed: true }),
    setEnabled: async (id) => { calls++; await gate; return { ok: true }; },
  };
  const first = setPluginSwitch('dedupe.plugin', true, bridge);
  const second = await setPluginSwitch('dedupe.plugin', true, bridge);
  assert.equal(second.code, 'duplicate-in-flight');
  resolveGate();
  await first;
  assert.equal(calls, 1);
  clearBridge();
});

// ---------- 可选能力：无 bridge 时缺口不拖垮整体（Codex #123）----------

test('缺口不拖垮整体：无 bridge 时三函数均不抛异常、兄弟模块照常加载、不造第二套开关', async () => {
  clearBridge();
  const INFLIGHT = Symbol.for('fish-body.plugin-switch.inflight.v1');
  try { delete globalThis[INFLIGHT]; } catch { /* noop */ }

  // 兄弟模块（身体自身开关）在完全相同的缺失环境下照常 import 与使用
  const { BODY_ENTRY_ID } = await import('../internal/backend/lib/body-switch.mjs');
  assert.equal(BODY_ENTRY_ID, 'fish-body', '兄弟模块照常加载，未被缺口模块拖垮');

  assert.doesNotThrow(() => isNativeSwitchAvailable());
  assert.equal(isNativeSwitchAvailable(), false);

  await assert.doesNotReject(async () => {
    const r = await readPluginSwitchState('demo.plugin');
    assert.equal(r.code, 'native-api-unavailable');
    assert.ok(Array.isArray(r.evidence) && r.evidence.length >= 5);
    assert.equal(r.enabled, null);
    assert.equal(r.runtime, 'unknown');
  });
  await assert.doesNotReject(async () => {
    const r = await setPluginSwitch('demo.plugin', true);
    assert.equal(r.code, 'native-api-unavailable');
    assert.equal(r.state, 'error');
  });

  // 缺口路径提前返回：不创建在途表、不注入/污染任何全局开关槽
  assert.equal(globalThis[NATIVE_BRIDGE_SLOT], undefined, '缺口路径未造第二套开关');
  assert.equal(globalThis[INFLIGHT], undefined, '缺口路径未提交请求、未创建在途表');
});
