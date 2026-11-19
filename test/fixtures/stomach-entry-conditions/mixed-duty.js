// 合成样本：同一函数混合审批、厌倦门禁、只读读取门禁与成功后的写入/副作用。
export const inject = ['systemPrompt'];
export function apply(ctx) {
  ctx.systemPrompt.section('persona', '保持拟人语气');
  ctx.tools.register('assistant_tool', '作者声明：助手同时处理审批、语气与只读查询。', mixedAssistant);
}

export function mixedAssistant(cap, mode) {
  if (!cap || !cap.bridge) return { ok: false, reason: 'approval-required' };
  if (persona.mood === 'bored') return { ok: false, reason: 'bored' };
  if (!ctx.isWrite) return { ok: true, status: 'read-only' };
  const profile = store.get('persona.profile');
  if ('assist' === mode) {
    bridge.call('assist', profile);
    activity.record('assist_success');
    reward.grant('assist_credit');
    feedback.watch('assist_result');
    return { ok: true, status: 'assisted' };
  }
  return { ok: false, status: 'not-accepted' };
}
