import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * 文件撤销的模型可见通知（spec: codex-desktop-file-rewind）。
 *
 * Desktop 撤销事务只在投影层把 turn 标记为 reverted，Codex 线程历史不可改写，
 * 模型因此不知道工作区已被恢复，下一轮会基于“修改还在”的错误前提行动。
 * bridge 在接受全新 overlay 时按 session 记录一次性通知，下一次 sendText 把它
 * prepend 到用户文本前——通知随消息进入 Codex 事实，气泡中同样可见（无展示/发送分离）。
 *
 * 通知是内存态、尽力而为：bridge 重启即丢，不影响 ledger/overlay 恢复语义；
 * 它也绝不阻断 sendText 本身的准入与发送。
 */

export interface RewindNoticeEntry {
  readonly turnId: string;
  /** 工作区相对路径（无法安全相对化时保留原投影路径）与该行级统计。 */
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
}

/**
 * 原生 fileChange 的 path 通常是绝对路径；通知文本面向模型与用户，
 * 统一相对工作区展示。无法安全相对化（越出工作区）时保留原路径，
 * 仅作展示用途，不做任何文件判定。
 */
export function relativizeRewindNoticePath(workspaceRoot: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(resolve(workspaceRoot), resolve(path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return path;
  return rel.split(sep).join("/");
}

export class RewindNoticeStore {
  private readonly pending = new Map<string, RewindNoticeEntry[]>();

  record(sessionId: string, entry: RewindNoticeEntry): void {
    const entries = this.pending.get(sessionId) ?? [];
    // 同一 turn 的 overlay 重放（重启后同 confirmationId 重试）不得重复登记。
    if (entries.some((existing) => existing.turnId === entry.turnId)) return;
    entries.push(entry);
    this.pending.set(sessionId, entries);
  }

  /**
   * 发送前读取但不消费：native 请求失败时通知必须留给下一次发送。
   * 返回快照副本——clear 只应清掉读取时的那一批，读取后并发 record 的新条目必须保留。
   */
  peek(sessionId: string): readonly RewindNoticeEntry[] | undefined {
    const entries = this.pending.get(sessionId);
    return entries && entries.length > 0 ? [...entries] : undefined;
  }

  /** 发送成功后消费恰好已读取的那批条目；期间新 record 的条目必须保留。 */
  clear(sessionId: string, consumed: readonly RewindNoticeEntry[]): void {
    const entries = this.pending.get(sessionId);
    if (!entries || entries.length === 0 || consumed.length === 0) return;
    const remaining = entries.filter((entry) => !consumed.includes(entry));
    if (remaining.length > 0) this.pending.set(sessionId, remaining);
    else this.pending.delete(sessionId);
  }
}

export function formatRewindNotice(entries: readonly RewindNoticeEntry[]): string {
  const files = entries.flatMap((entry) => entry.files);
  const lines = files.map((file) => `- \`${file.path}\` (+${file.additions}/-${file.deletions})`);
  const turnCount = entries.length;
  return [
    "[User action: file changes reverted]",
    `The user reverted the file edits made in ${turnCount} earlier turn${
      turnCount === 1 ? "" : "s"
    } of this conversation:`,
    ...lines,
    "The workspace has been restored to the state before those edits. Do not assume those edits still exist; re-read the files if you need their current contents.",
  ].join("\n");
}
