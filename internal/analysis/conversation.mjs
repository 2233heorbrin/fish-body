// Guidance for the existing conversation model, never a backend model request.
export const DISCUSSION_GUIDE = '先按需分页核对证据：作者描述/能力目录不是入口实际接受范围，结论“支持某动作”前核对筛选和早退；遇截断用 file 的 queryOptions.view="source" 取已验证快照行段，按 nextLine 与 nextOffset 续读。描述与代码冲突如实说明，未取得条件则保持未确定，不用描述补齐事实。区分所选声明内观察与全插件背景，当前调用不等于功能必需；分别解释当前接线、工具控制、拟人行为和其他副作用，核查保留/替换理由、使用影响及后续适配点。不能建议全部保留背景候选，也不能直接删除仍被调用的组件。再用自然语言解释功能并推荐取舍，只问少量影响功能的问题，不让用户逐条裁定技术调用、查哈希或读源码。区分程序事实、当前模型建议与用户真实决定；以 current-model 归属保存 taskPatch.explanation 并关联现有有效证据，源码行段只作坐标上下文，未经用户接受保持 pending。initial 不证明完整行为或最小依赖；compatibility 仅待执行方案，reverse 仅源码理解材料；说明后续适配、验证、打包、安装缺口，不执行、不安装、不写全局脑区、不新建模型请求或 Worker。';
export function conversationGuide({ taskId, analysisId, revision, mode } = {}) {
  return { next: DISCUSSION_GUIDE,
    prompt: taskId ? `请继续解释鱼胃任务 ${taskId}（版本 ${revision}，${mode === 'reverse' ? '逆向拆分' : '兼容拆分'}）。请先用 fish_hand task read 刷新任务、按需 query 核对证据，再按我的功能目标给出可读推荐和少量待选问题，将说明以 current-model 归属保存；不要替我确认或执行适配/安装。` : `请用 fish_hand 读取分析 ${analysisId} 的必要证据，解释插件能做什么，并按我的目标推荐能力取舍。不要让我研究编号、哈希或源码；还未发生用户接受的决定继续待定。` };
}
