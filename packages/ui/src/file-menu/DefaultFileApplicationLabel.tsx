import type { ReactNode } from "react";
import type { FileApplicationInfo } from "@codez/shared";
import { ExternalLinkIcon } from "lucide-react";
import { FileApplicationIcon } from "@/file-menu/FileApplicationIcon.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";

/** 已知默认应用才展示其身份；中性系统动作不能借用首个候选或历史选择的图标。 */
export function DefaultFileApplicationLabel({
  application,
  children,
}: {
  application?: FileApplicationInfo | null;
  children?: ReactNode;
}) {
  const { intl } = useCodezIntl();
  const label =
    children ??
    intl.formatMessage(
      { id: application ? "fileActions.openInApplication" : "chat.previewCards.openDefaultApp" },
      application ? { application: application.name } : undefined,
    );
  return (
    <>
      {application ? (
        <FileApplicationIcon applicationId={application.id} iconDataUrl={application.iconDataUrl} />
      ) : (
        <ExternalLinkIcon aria-hidden="true" className="size-4" />
      )}
      {/* 应用名称较长时保持单行，避免一个汉字被挤成第二行；完整动作仍可通过 title 查看。 */}
      <span
        className="min-w-0 flex-1 truncate"
        title={typeof label === "string" ? label : undefined}
      >
        {label}
      </span>
    </>
  );
}
