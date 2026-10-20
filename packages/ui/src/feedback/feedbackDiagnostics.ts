import {
  CODEZ_BUILD_TIME,
  CODEZ_COMMIT,
  CODEZ_VERSION,
  type FeedbackDeviceInfo,
} from "@codez/shared";

/**
 * 反馈与诊断预填模型：固定走本项目 GitHub Issues（不设渠道切换或关闭开关），
 * 全程零凭证、零后台出网，只在用户点击时通过外部浏览器打开预填链接。
 */

export const DEFAULT_FEEDBACK_REPOSITORY_URL = "https://github.com/KingingWang/Codez";

/** 保证最终 GitHub 新建 Issue URL 不超过浏览器与 GitHub GET 查询长度安全范围。 */
export const MAX_FEEDBACK_PREFILLED_URL_LENGTH = 7200;

export type FeedbackDiagnosticFieldId = "app" | "runtime" | "error" | "notes";

export const FEEDBACK_DIAGNOSTIC_FIELD_IDS: readonly FeedbackDiagnosticFieldId[] = [
  "app",
  "runtime",
  "error",
  "notes",
];

export const FEEDBACK_DIAGNOSTIC_FIELD_LABEL_IDS: Record<FeedbackDiagnosticFieldId, string> = {
  app: "settings.feedback.diagnostics.field.app",
  runtime: "settings.feedback.diagnostics.field.runtime",
  error: "settings.feedback.diagnostics.field.error",
  notes: "settings.feedback.diagnostics.field.notes",
};

export interface FeedbackDiagnosticInput {
  /** 仅接受已本地化、脱敏后的可读错误摘要，不接受原始错误对象或堆栈。 */
  errorSummary?: string;
  /** 用户自述或入口模板生成的问题描述（可选）。 */
  description?: string;
}

export interface FeedbackDiagnosticRuntime {
  /**
   * 来自 IFeedbackService.getDeviceSnapshot() 的本地设备快照。
   * 快照本身包含 deviceMid / hostname，但 buildFeedbackDiagnosticEntries 只按名读取
   * 版本与平台字段，不会把设备身份写进诊断条目。
   */
  device?: FeedbackDeviceInfo;
}

export interface FeedbackDiagnosticEntry {
  id: FeedbackDiagnosticFieldId;
  value: string;
}

/** 平台标识转可读名称；未知平台原样返回，避免为了展示把信息丢掉。 */
export function describePlatform(platform: string | undefined): string {
  switch (platform?.trim().toLowerCase()) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform?.trim() || "unknown";
  }
}

/**
 * 构造脱敏诊断字段。这里刻意只收「版本 + 平台 + 用户可见错误摘要 + 描述」：
 * deviceMid、hostname、账号标识、凭据、完整日志一律不进预填正文。
 */
export function buildFeedbackDiagnosticEntries(
  input: FeedbackDiagnosticInput,
  runtime: FeedbackDiagnosticRuntime = {},
): FeedbackDiagnosticEntry[] {
  const device = runtime.device;
  const appVersion = device?.appVersion?.trim() || CODEZ_VERSION;
  const buildCommit = device?.buildCommitId?.trim() || CODEZ_COMMIT;
  const buildTime = device?.buildTime?.trim() || CODEZ_BUILD_TIME;
  const platform = device?.osPlatform?.trim() || device?.osType?.trim();
  const release = device?.osRelease?.trim() || device?.osVersion?.trim();
  const arch = device?.osArch?.trim() || "unknown";
  const nodeVersion = device?.nodeVersion?.trim();
  const electronVersion = device?.electronVersion?.trim();

  const entries: FeedbackDiagnosticEntry[] = [
    {
      id: "app",
      value: `Codez ${appVersion} (${buildCommit}, built ${buildTime})`,
    },
    {
      id: "runtime",
      value: [
        `OS ${describePlatform(platform)}${release ? ` ${release}` : ""} / ${arch}`,
        nodeVersion ? `Node ${nodeVersion}` : null,
        electronVersion ? `Electron ${electronVersion}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" | "),
    },
  ];

  const errorSummary = input.errorSummary?.trim();
  if (errorSummary) {
    entries.push({ id: "error", value: errorSummary });
  }
  const description = input.description?.trim();
  if (description) {
    entries.push({ id: "notes", value: description });
  }
  return entries;
}

const DIAGNOSTIC_SECTION_HEADINGS: Record<"zh-CN" | "en-US", string> = {
  "zh-CN": "### 诊断信息（自动生成，可删除）",
  "en-US": "### Diagnostics (generated, safe to delete)",
};

export function buildFeedbackBody(
  entries: ReadonlyArray<{ label: string; value: string }>,
  options: {
    locale: "zh-CN" | "en-US";
    attachmentHint?: string;
  },
): string {
  if (entries.length === 0) {
    return "";
  }
  const lines = [
    DIAGNOSTIC_SECTION_HEADINGS[options.locale],
    "",
    ...entries.map((entry) => `- ${entry.label}: ${entry.value}`),
  ];
  const hint = options.attachmentHint?.trim();
  if (hint) {
    lines.push("", `> ${hint}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** 标题只取首行并限长，避免多行描述把 issue 标题撑成正文。 */
export function buildFeedbackIssueTitle(description: string | undefined): string {
  const normalized =
    description
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return normalized.slice(0, 80);
}

/**
 * 只允许 http/https 作为反馈目标。
 *
 * 安全边界：`new URL("javascript:alert(1)")` 与 `data:` / `file:` 都能正常解析，
 * 必须在这里 fail-closed，避免通过 openExternal 执行脚本或打开本地文件。
 */
export function isAllowedFeedbackProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function buildIssueUrlWithParams(baseUrl: string, title: string, body: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (!isAllowedFeedbackProtocol(url.protocol)) {
    return null;
  }
  if (title) {
    url.searchParams.set("title", title);
  }
  if (body) {
    url.searchParams.set("body", body);
  }
  return url.toString();
}

const DEFAULT_TRUNCATED_NOTICES: Record<"zh-CN" | "en-US", string> = {
  "zh-CN": "（预填内容因 URL 长度限制已截断，请在 GitHub 页面补充完整信息）",
  "en-US":
    "(Pre-filled text was truncated due to URL length limits. Please add the full details on GitHub.)",
};

/**
 * 生成最终要打开的 GitHub Issues 预填链接。
 * 返回 null 表示目标地址非法或非 http/https（fail-closed）。
 */
export function buildFeedbackPrefilledUrl(options: {
  repositoryUrl?: string;
  title: string;
  body: string;
  locale: "zh-CN" | "en-US";
  truncatedNotice?: string;
  maxUrlLength?: number;
}): string | null {
  const rawRepo = (options.repositoryUrl ?? DEFAULT_FEEDBACK_REPOSITORY_URL).trim();
  if (!rawRepo) {
    return null;
  }
  let repoUrl: URL;
  try {
    repoUrl = new URL(rawRepo);
  } catch {
    return null;
  }
  if (!isAllowedFeedbackProtocol(repoUrl.protocol)) {
    return null;
  }
  const baseIssueUrl = `${repoUrl.toString().replace(/\/+$/, "")}/issues/new`;
  const issueTitle =
    options.title.trim().slice(0, 80) || (options.locale === "en-US" ? "Feedback" : "反馈");
  const maxLength = options.maxUrlLength ?? MAX_FEEDBACK_PREFILLED_URL_LENGTH;

  const fullUrl = buildIssueUrlWithParams(baseIssueUrl, issueTitle, options.body);
  if (!fullUrl || fullUrl.length <= maxLength) {
    return fullUrl;
  }

  const notice = options.truncatedNotice?.trim() || DEFAULT_TRUNCATED_NOTICES[options.locale];
  const suffix = `\n\n${notice}`;
  let low = 0;
  let high = options.body.length;
  let bestBody = notice;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidateBody = `${options.body.slice(0, mid).trimEnd()}${suffix}`;
    const candidateUrl = buildIssueUrlWithParams(baseIssueUrl, issueTitle, candidateBody);
    if (candidateUrl && candidateUrl.length <= maxLength) {
      bestBody = candidateBody;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return buildIssueUrlWithParams(baseIssueUrl, issueTitle, bestBody);
}
