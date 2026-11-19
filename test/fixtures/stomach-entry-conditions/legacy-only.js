// 合成样本：旧结果只有普通函数，没有 phases.entryConditions。
export function oldEntry(cap) {
  if (!cap) return null;
  return { ok: true, status: 'legacy' };
}
