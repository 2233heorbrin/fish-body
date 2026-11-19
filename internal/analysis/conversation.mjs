// Guidance for the existing conversation model, never a backend model request.
export const DISCUSSION_GUIDE = [
'先按需分页核对结构化证据再解释功能。permissionGate（进入该动作须先通过的许可条件）、earlyExits（触发早退、实际接不到该动作的情况）、comparisons（比较运算与分支极性）、actionCandidates（动作入口候选）要分别读；作者描述/能力目录不是入口实际接受范围。acceptsAction（真正接到该动作的入口）为旧版措辞，现仅指有限规则下无歧义时的单值候选，为 null 也如实呈现，不代替 actionCandidates。遗漏用 entry-conditions 按 run/scope 枚举或 file view=source 续读；摘要裁剪不代表无更多候选。',
'【一、按各自入口分别解释，不合并成一条业务链】',
'1）每个可定位入口（独立回调、统一桥接、消息/回复跟踪等）只按自己的 permissionGate、earlyExits、comparisons、actionCandidates 与 relations 解释：进入条件、哪些情况接不到、调用与写入归属谁。共享 check/helper 的条件另行追溯，不凭名字判纯读或无副作用，不宣称底层绝无副作用。',
'2）当前调用、状态写入、活动/奖励/反馈跟踪都按所在入口条件解释，不能归到另一入口；当前调用不等于功能必需。反馈/回复跟踪另有前置条件（如能力标识、非试运行、目标存在），按入口核对，不是任何成功动作都会跟踪，更不能并到投稿回调。线程存在检查不证明互斥或同一时间只做一件事。',
'3）同一功能不同入口分别说明，不因字符串、工具名或同文件相同而合并；缺条件保持未确定，不用作者描述补齐。',
'【二、当前事实 / 仍待核实 / 若想改变体验需要新增或改接什么】',
'当前事实：每条来自可定位入口与结构化候选；奖励、活动记录、回复跟踪分别说明保留/去掉的影响，不打包成一个开关。',
'仍待核实：共享 check 条件与底层副作用、动作与满足度对应、跟踪类入口前置条件、活动线程与互斥关系；缺证据保持未确定。',
'若想改变体验：按入口分别指出新增或改接处——关奖励、去活动记录、停跟踪各落其入口；无直接证据不宣称行为已存在或消失。',
'【三、怎么对用户说】',
'用自然语言按功能、理由和实际影响说明，只问少量影响体验的问题；不让用户逐条裁定技术调用、查哈希、看源码、读编号或核对源码行段。源码行段只作坐标上下文，不作证明。区分程序事实（已定位代码与结构化条件）、有限候选（语法线索）、当前模型建议与用户真实决定；以 current-model 归属保存 taskPatch.explanation 并关联现有有效证据，未经用户接受保持 pending。initial/compatibility/reverse 各为材料非证明；说明适配、验证、打包、安装缺口，不执行、不安装、不写全局脑区、不新建模型请求或 Worker。'
].join('\n');
export function conversationGuide({ taskId, analysisId, revision, mode } = {}) {
  return { next: DISCUSSION_GUIDE,
    prompt: taskId ? `请继续解释鱼胃任务 ${taskId}（版本 ${revision}，${mode === 'reverse' ? '逆向拆分' : '兼容拆分'}）。请先用 fish_hand task read 刷新任务、按需 query 核对证据，再按我的功能目标给出可读推荐和少量待选问题，将说明以 current-model 归属保存；不要替我确认或执行适配/安装。` : `请用 fish_hand 读取分析 ${analysisId} 的必要证据，解释插件能做什么，并按我的目标推荐能力取舍。不要让我研究编号、哈希或源码；还未发生用户接受的决定继续待定。` };
}
