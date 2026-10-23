export type NativeStderrCategory =
  | "panic"
  | "permission-denied"
  | "not-found"
  | "connection"
  | "timeout"
  | "tls"
  | "out-of-memory"
  | "error";

export type NativeStderrLevel = "trace" | "debug" | "info" | "warn" | "error" | "unknown";

export interface NativeStderrSummary {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  lineCount: number;
  byteCount: number;
  truncated: boolean;
  level: NativeStderrLevel;
  target: string | undefined;
  categories: NativeStderrCategory[];
}

const MAX_CLASSIFICATION_BYTES = 2048;
const LEVEL_RANK: Record<NativeStderrLevel, number> = {
  unknown: 0,
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
};
const TARGET_PATTERN = /^(?:[a-z0-9_]+::){1,5}[a-z0-9_]+$/;
const LEVEL_PREFIX =
  /^\s*(?:\S{1,64}\s+){0,4}(TRACE|DEBUG|INFO|WARN|ERROR)[\s]+((?:[a-z0-9_]+::){1,5}[a-z0-9_]+|.{0,128}?)(?::|\s)/;
const CATEGORY_PATTERNS: readonly [NativeStderrCategory, RegExp][] = [
  ["panic", /(?:^|[^a-z])panicked(?: at|$)|\bpanic\b/i],
  ["out-of-memory", /\boom\b|\bout of memory\b|memory allocation/i],
  ["permission-denied", /\bpermission denied\b|\bEACCES\b|\bEPERM\b/i],
  ["not-found", /\bnot found\b|\bENOENT\b/i],
  ["connection", /\bconnection\b|\bECONNREFUSED\b|\bECONNRESET\b|\bEPIPE\b/i],
  ["timeout", /\btimeout\b|\btimed out\b/i],
  ["tls", /\btls\b|\bssl\b|\bcertificate\b/i],
  ["error", /\berror\b|\bfailed\b/i],
];

/**
 * 流式摘要不保存 stderr 原文；长行只保留最多 2 KiB 的分类前缀。
 * 这能防止无换行日志把 bridge 进程内存撑爆，也避免私密内容越过 transport。
 */
export class NativeStderrSummarizer {
  #lineCount = 0;
  #byteCount = 0;
  #truncated = false;
  #lineBuffer = Buffer.alloc(0);
  #lineBufferFull = false;
  #level: NativeStderrLevel = "unknown";
  #target: string | undefined;
  #categories = new Set<NativeStderrCategory>();
  #currentLineHasContent = false;

  append(chunk: Buffer): void {
    this.#byteCount += chunk.length;
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      this.#absorbClassification(chunk.subarray(start, index));
      this.#classifyLine(this.#lineBuffer);
      this.#lineBuffer = Buffer.alloc(0);
      this.#lineBufferFull = false;
      this.#currentLineHasContent = false;
      start = index + 1;
    }
    if (start < chunk.length) {
      this.#absorbClassification(chunk.subarray(start));
      this.#currentLineHasContent = true;
    }
  }

  finish(): Pick<
    NativeStderrSummary,
    "lineCount" | "byteCount" | "truncated" | "level" | "target" | "categories"
  > {
    if (this.#currentLineHasContent) {
      this.#classifyLine(this.#lineBuffer);
      this.#lineBuffer = Buffer.alloc(0);
      this.#lineBufferFull = false;
      this.#currentLineHasContent = false;
    }
    return {
      lineCount: this.#lineCount,
      byteCount: this.#byteCount,
      truncated: this.#truncated,
      level: this.#level,
      target: this.#target,
      categories: [...this.#categories],
    };
  }

  #absorbClassification(segment: Buffer): void {
    if (this.#lineBufferFull) return;
    const take = Math.min(segment.length, MAX_CLASSIFICATION_BYTES - this.#lineBuffer.length);
    if (take > 0) this.#lineBuffer = Buffer.concat([this.#lineBuffer, segment.subarray(0, take)]);
    if (take < segment.length) {
      this.#lineBufferFull = true;
      this.#truncated = true;
    }
  }

  #classifyLine(line: Buffer): void {
    this.#lineCount += 1;
    const text = line.toString("utf8");
    this.#classifyLevelAndTarget(text);
    for (const [category, pattern] of CATEGORY_PATTERNS) {
      if (pattern.test(text)) this.#categories.add(category);
    }
  }

  #classifyLevelAndTarget(text: string): void {
    const bracket =
      /^\s*\[?\s*(TRACE|DEBUG|INFO|WARN|ERROR)[ \t]+((?:[a-z0-9_]+::){1,5}[a-z0-9_]+|.{0,128}?)(?::|\]|[ \t])/.exec(
        text,
      );
    const space =
      /^\s*(TRACE|DEBUG|INFO|WARN|ERROR)[ \t]+((?:[a-z0-9_]+::){1,5}[a-z0-9_]+|.{0,128}?)(?::|[ \t])/.exec(
        text,
      );
    const prefixed = LEVEL_PREFIX.exec(text);
    const match = bracket ?? space ?? prefixed;
    if (!match) return;
    const level = match[1]!.toLowerCase() as NativeStderrLevel;
    if (LEVEL_RANK[level] > LEVEL_RANK[this.#level]) {
      this.#level = level;
      // 新的最高级别不能沿用低级别 target；同级后续行仍可补全有效 target。
      this.#target = undefined;
    }
    if (LEVEL_RANK[level] >= LEVEL_RANK[this.#level] && TARGET_PATTERN.test(match[2]!)) {
      this.#target = match[2]!;
    }
  }
}
