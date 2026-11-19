// 合成样本：另一路入口在独立 studio 上下文中接受同一动作，用来验证“另一入口才接收”。
registerTool('publish_video_studio', '作者声明：可从独立创作入口把视频发布到远端，并记录投稿状态。', publishThroughStudio);
export function publishThroughStudio(studio, action, payload) {
  if (!studio || !studio.ready) return { ok: false, reason: 'studio-not-ready' };
  if (action !== 'publish') return { ok: false, reason: 'action-not-accepted' };
  if ('publish' === action) {
    studio.dispatch(payload);
    activity.record('studio_publish_success');
    return { ok: true, status: 'studio-published' };
  }
  return { ok: false, status: 'unreachable-synthetic' };
}
