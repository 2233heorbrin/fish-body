// Guidance for the existing conversation model, never a backend model request.
export const DISCUSSION_GUIDE = '读取材料后，先分页核对与用户目标有关的证据，再用自然语言解释插件实际功能，推荐保留与排除的能力并说明理由；说明连带保留的服务有什么用、会产生哪些使用影响。区分程序事实、当前模型建议与用户真实决定。只询问影响功能或行为的少量选择，不把所有技术未知项转交用户，不要求用户找哈希、读源码或抄内部编号。将说明以 current-model 归属写入 taskPatch.explanation，关联当前能力、依赖和有效证据；未经用户接受的取舍保持 pending。说明后续适配、验证、打包和安装尚缺什么；compatibility 仅为待执行方案，reverse 仅为源码理解材料，不执行、不安装，不写全局脑区，不新建模型请求或 Worker。';
export function conversationGuide({ taskId, analysisId, revision, mode } = {}) {
  return { next: DISCUSSION_GUIDE,
    prompt: taskId ? `请继续解释鱼胃任务 ${taskId}（版本 ${revision}，${mode === 'reverse' ? '逆向拆分' : '兼容拆分'}）。请先用 fish_hand task read 刷新任务、按需 query 核对证据，再按我的功能目标给出可读推荐和少量待选问题，将说明以 current-model 归属保存；不要替我确认或执行适配/安装。` : `请用 fish_hand 读取分析 ${analysisId} 的必要证据，解释插件能做什么，并按我的目标推荐能力取舍。不要让我研究编号、哈希或源码；还未发生用户接受的决定继续待定。` };
}
