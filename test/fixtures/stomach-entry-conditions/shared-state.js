// 合成样本：两个无关功能读取同一共享状态；选择 Alpha 不应自动复制/删除 Beta。
export function featureAlpha(cap) {
  if (!cap || !cap.bridge) return null;
  return settings.get('shared.theme');
}

export function featureBeta(cap) {
  if (!cap || !cap.studio) return null;
  return settings.get('shared.theme');
}
