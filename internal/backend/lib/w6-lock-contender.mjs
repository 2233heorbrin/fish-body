/**
 * W6-A 跨进程锁争用探针（独立进程）。
 *
 * 用法：node w6-lock-contender.mjs <profileDir> <timelinePath> <waitMs>
 * 成功：取得锁并进入临界区，输出 {"ok":true,...}
 * 失败：等待超时（说明主部署仍持锁），输出 {"ok":false,...}，退出码 2。
 *
 * 关键：这个进程与主部署器用**同一把原生锁** `<profile>/package.json.lock`；
 * timeline 里的 attempt-lock / enter-critical / leave-critical 事件与时间由
 * w6-lock.mjs 统一记录，供 analyzeLockTimeline() 判定「第二次安装不能插入恢复过程」。
 */

import { withNativeInstallLock } from './w6-lock.mjs';

const [, , profileDir, timelinePath, waitMsArg] = process.argv;
const waitMs = Number(waitMsArg) || 30000;

try {
  await withNativeInstallLock(profileDir, async ({ line }) => {
    line('contender-work', { note: '第二次安装：已在持锁状态下进入临界区' });
    return true;
  }, { label: 'contender', timelinePath, waitMs });
  process.stdout.write(JSON.stringify({ ok: true, acquired: true, waitMs }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false, acquired: false, waitMs,
    error: String(error?.message ?? error),
    note: '等待超时：主部署仍持有原生安装锁，第二次安装被排除在临界区之外',
  }) + '\n');
  process.exitCode = 2;
}
