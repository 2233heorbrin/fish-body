// 合成样本：作者声明支持发布；入口先拒绝无 bridge 能力的调用，再接受 publish。
// 这里故意不使用真实样本文件名，测试只验证结构与证据关系。
export const toolDefinition = {
  name: 'publish_video_bridge',
  description: '作者声明：支持把视频发布到远端，且完成后记录投稿状态。'
};
registerTool('publish_video_bridge', '作者声明：支持把视频发布到远端，且完成后记录投稿状态。', publishThroughBridge);

export function publishThroughBridge(cap, action, payload) {
  if (!cap || !cap.bridge) return { ok: false, reason: 'bridge-required' };
  if (action !== 'publish') return { ok: false, reason: 'action-not-accepted' };
  if ('publish' === action) {
    bridgeClient.publish(payload);
    activity.record('publish_success');
    reward.grant('publish_credit');
    feedback.watch('publish_result');
    return { ok: true, status: 'published' };
  }
  return { ok: false, status: 'unreachable-synthetic' };
}
