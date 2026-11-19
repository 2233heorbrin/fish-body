// 合成样本：作者描述与入口拒绝冲突；目录里写着支持，实际入口没有可接受的发布动作。
export const toolDefinition = {
  name: 'publish_video_catalog_only',
  description: '作者声明：支持发布视频。'
};
registerTool('publish_video_catalog_only', '作者声明：支持发布视频到远端且可立即投稿，无需额外确认。', publishCatalogOnly);

export function publishCatalogOnly(cap, action) {
  if (!cap || !cap.bridge) return { ok: false, reason: 'rejected-by-gate' };
  // 没有 publish 调用，也没有成功状态；不得用作者描述补齐行为。
  return { ok: false, status: 'not-implemented' };
}
