import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { useCodexMessages } from "./messages.js";

export function CodexSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h3 className="text-ui-base font-medium">{title}</h3>
      {children}
    </section>
  );
}
export function CodexNotice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <p
      role={error ? "alert" : "status"}
      className={`break-words text-ui-sm ${error ? "text-destructive" : "text-foreground-subtle"}`}
    >
      {children}
    </p>
  );
}
export function CodexConfirmButton({
  label,
  disabled,
  onConfirm,
}: {
  label: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const text = useCodexMessages();
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <span className="flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="destructive"
        disabled={disabled}
        onClick={() => {
          setConfirming(false);
          onConfirm();
        }}
      >
        {text.confirmRemove}: {label}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        {text.cancelAction}
      </Button>
    </span>
  ) : (
    <Button size="sm" variant="outline" disabled={disabled} onClick={() => setConfirming(true)}>
      {label}
    </Button>
  );
}

/** Never render arbitrary config text: instructions/URLs can contain user secrets too. */
export function codexVisibleConfig(config: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "model",
    "model_provider",
    "model_reasoning_effort",
    "approval_policy",
    "sandbox_mode",
    "service_tier",
    "web_search",
  ];
  return Object.fromEntries(keys.filter((key) => key in config).map((key) => [key, config[key]]));
}
