// 合成样本：动态属性、多源赋值合并判断、嵌套函数早退，均属于支持边界之外。
let guard = flags.defaultGuard;
guard = flags.runtimeGuard ?? guard;

export function dynamicEntry(cap, key) {
  if (!cap || !cap[key]) return { ok: false, reason: 'dynamic-property' };
  function inner() { return 'inner-reject'; }
  return { ok: true, inner: inner() };
}
