import { useEffect, useRef, useState } from "react";
import { Loader2Icon } from "lucide-react";
import type { CodezTaskSnapshotToolFieldRef } from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";

export function isV4LazyRowPayloadRef(ref: CodezTaskSnapshotToolFieldRef): boolean {
  return typeof ref.refId === "string" && ref.refId.startsWith("v4-row-payload/");
}

export function ToolSnapshotFieldNotice({
  refs,
  autoLoadWhenMounted = false,
  onLoadFullToolCallFields,
}: {
  refs: readonly CodezTaskSnapshotToolFieldRef[];
  autoLoadWhenMounted?: boolean;
  onLoadFullToolCallFields?: () => Promise<boolean | void> | boolean | void;
}) {
  const { intl, locale } = useCodezIntl();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const autoLoadKeyRef = useRef<string | null>(null);
  const loadCallbackRef = useRef(onLoadFullToolCallFields);
  loadCallbackRef.current = onLoadFullToolCallFields;
  const hasNonV4Refs = refs.some((ref) => !isV4LazyRowPayloadRef(ref));
  const autoLoadKey = autoLoadWhenMounted
    ? refs
        .filter(isV4LazyRowPayloadRef)
        .map((ref) => `${ref.field}:${ref.refId}`)
        .join("|")
    : "";

  useEffect(() => {
    if (!autoLoadKey || !loadCallbackRef.current || autoLoadKeyRef.current === autoLoadKey) {
      return;
    }
    autoLoadKeyRef.current = autoLoadKey;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void Promise.resolve(loadCallbackRef.current())
      .then(
        (result) => {
          if (!cancelled) setFailed(result === false);
        },
        () => {
          if (!cancelled) setFailed(true);
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [autoLoadKey]);

  if (refs.length === 0 || !onLoadFullToolCallFields) {
    return null;
  }
  // V4 折叠懒加载引用在未展开时不渲染提示条；只有展开后（autoLoadWhenMounted=true）才触发自动拉取并在加载/失败时显示提示。
  if (!hasNonV4Refs && !autoLoadWhenMounted) {
    return null;
  }

  const previewBytes = refs.reduce((total, ref) => total + ref.previewBytes, 0);
  const fullBytes = refs.reduce((total, ref) => total + ref.fullBytes, 0);
  const description = intl.formatMessage(
    { id: "chat.toolCall.snapshot.notice" },
    {
      fields: String(refs.length),
      previewBytes: formatBytes(previewBytes, locale),
      fullBytes: formatBytes(fullBytes, locale),
    },
  );
  const buttonLabel = intl.formatMessage({
    id: loading
      ? "chat.toolCall.snapshot.loading"
      : failed
        ? "chat.toolCall.snapshot.retry"
        : "chat.toolCall.snapshot.loadFull",
  });

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/70 bg-muted/40 px-3 py-2 text-ui-base text-foreground-subtle sm:flex-row sm:items-center sm:justify-between">
      <span>{description}</span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-7 self-start px-2 text-ui-base sm:self-auto"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          setFailed(false);
          void Promise.resolve(onLoadFullToolCallFields())
            .then(
              (result) => {
                setFailed(result === false);
              },
              () => {
                setFailed(true);
              },
            )
            .finally(() => {
              setLoading(false);
            });
        }}
      >
        {loading ? <Loader2Icon className="mr-1 size-3 animate-spin" /> : null}
        {buttonLabel}
      </Button>
    </div>
  );
}

function formatBytes(bytes: number, locale: string): string {
  if (bytes >= 1024 * 1024) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
  }
  if (bytes >= 1024) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;
  }
  return `${new Intl.NumberFormat(locale).format(bytes)} B`;
}
