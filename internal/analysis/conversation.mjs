// Guidance for the existing conversation model, never a backend model request.
export const DISCUSSION_GUIDE = [
 '先按需分页核对结构化证据再解释功能。permissionGate、earlyExits、comparisons、actionCandidates 分别读；permissionGate 结合比较极性/条件真假与 then/else、earlyExits 解释，不能统称“条件为真才许可”；作者描述/能力目录≠入口实际接受范围；acceptsAction 为旧措辞，仅指无歧义时单值候选，null 如实呈现、不代替 actionCandidates。入口归属按所选功能在其上下文（name/run/scope 等）查询，无功能语境的全局 unknown≠各功能都无法归属；遗漏用 entry-conditions 枚举或 file view=source 续读，摘要裁剪≠无更多候选。',
 '【一、按入口分别解释，不合并成一条业务链】每条可定位入口只按自身 permissionGate/earlyExits/comparisons/actionCandidates 与 relations 解释进入条件、哪些接不到、调用与写入归属；共享 check/helper 另行追溯，不凭名字判纯读或全无副作用。调用、写入、活动/奖励/跟踪按所在入口解释、不归别的入口，当前调用≠功能必需；跟踪类另有前置（能力标识、非试运行、目标存在），非任何成功动作都跟踪，也不并入别的动作回调；线程存在≠互斥。',
 '【二、调用语法≠实际效果】仅在要对“实际累加/写入/执行”下结论时，按需核对调用实参与被调实现的相关分支/早退，把“语法调用”“局部静态推论”“运行效果”分别表述；查不到实现或不支持跨函数关系就保留未知，不要求穷尽所有调用。',
 '【三、删除/停用看读取者与触发路径】检查相关状态的已知读取者、准入/提示消费者及其他触发入口；不从停一个写入者/入口推所有路径均停；未找到读取者≠不存在，不假装已有完整自动读写依赖图。当前相连依赖≠适配后必留整个组件；不同调用路径≠已有配置开关；提示词要求≠程序强制/死锁。',
 '【四、源码与当前事实】源码行段本身只是坐标与上下文、非证明；但核对过的实现可支持局部静态判断，区分坐标、已核对实现与运行副作用/可安全拆分/已完成安装，不把静态推论升级为运行证明，也不因此否定一切局部结论。当前事实来自可定位入口与结构化候选；奖励、活动记录、回复跟踪分别说明保留/去掉影响、不打包成一个开关；共享副作用、动作与满足度对应、跟踪前置、线程互斥缺证据保持未确定。',
 '【五、怎么对用户说】自然语言按功能、理由、影响说明，只问少量影响体验的问题，不让用户裁定技术调用、查哈希、看源码、读编号或核对行段；区分程序事实、有限候选、模型建议与用户真实决定，以 current-model 归属保存 taskPatch.explanation 并关联现有证据，未经用户接受保持 pending；initial/compatibility/reverse 为材料非证明，说明适配/验证/打包/安装缺口，不执行、不安装、不写全局脑区、不新建模型请求或 Worker。'
].join('\n');
export function conversationGuide({ taskId, analysisId, revision, mode } = {}) {
  return { next: DISCUSSION_GUIDE,
    prompt: taskId ? `请继续解释鱼胃任务 ${taskId}（版本 ${revision}，${mode === 'reverse' ? '逆向拆分' : '兼容拆分'}）。请先用 fish_hand task read 刷新任务、按需 query 核对证据，再按我的功能目标给出可读推荐和少量待选问题，将说明以 current-model 归属保存；不要替我确认或执行适配/安装。` : `请用 fish_hand 读取分析 ${analysisId} 的必要证据，解释插件能做什么，并按我的目标推荐能力取舍。不要让我研究编号、哈希或源码；还未发生用户接受的决定继续待定。` };
}
