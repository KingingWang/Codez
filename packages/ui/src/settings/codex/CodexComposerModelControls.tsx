import type { ModelSelection } from "@codez/shared";
import type { CodexModelCatalogRead } from "@/hooks/useCodexModelCatalog.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useCodexMessages } from "./messages.js";

export function CodexComposerModelControls({
  read,
  selection,
  disabled,
  busy = false,
  onSelectModel,
  onSelectThought,
}: {
  read: CodexModelCatalogRead;
  selection?: ModelSelection;
  disabled: boolean;
  busy?: boolean;
  onSelectModel(provider: string, model: string, source: null): void;
  onSelectThought(effort: string, context: { provider: string; model: string }): void;
}) {
  const text = useCodexMessages();
  const catalog = read.catalog;
  const model = catalog?.models.find((candidate) => candidate.model === selection?.modelId);
  const locked = disabled || busy;
  const configured = catalog?.configuredSelection;
  const configuredSelected = configured && configured.modelId === selection?.modelId;
  if (read.status !== "ready" || !catalog)
    return (
      <div className="flex flex-wrap items-center gap-2 text-ui-sm">
        <span role={read.error ? "alert" : "status"}>
          {read.error ?? (read.status === "unavailable" ? text.workspace : text.loading)}
        </span>
        <Button size="sm" variant="ghost" onClick={read.reload}>
          {text.refresh}
        </Button>
      </div>
    );
  return (
    <div data-testid="codex-composer-models" className="flex min-w-0 flex-wrap items-center gap-2">
      <Select
        value={selection?.modelId ?? ""}
        disabled={locked}
        onValueChange={(value) => {
          if (locked) return;
          // configuredSelection 是激活 provider 的配置事实；目录模型按分组归属，
          // providerId 必须跟随模型的实际 catalog provider（执行路由事实）。
          const owner =
            configured && value === configured.modelId
              ? configured.providerId
              : (catalog.groups.find((group) => group.models.some((entry) => entry.model === value))
                  ?.providerId ?? catalog.providerId);
          onSelectModel(owner, value, null);
        }}
      >
        <SelectTrigger aria-label={text.model} className="h-7 max-w-56 text-ui-sm">
          <SelectValue placeholder={text.model} />
        </SelectTrigger>
        <SelectContent>
          {configured && (
            <SelectItem value={configured.modelId}>
              {configured.modelId} · {text.configured}
            </SelectItem>
          )}
          {catalog.groups.map((group) => (
            <SelectGroup key={group.providerId}>
              {/* 单 provider 部署不显示组标签，与分组引入前的扁平列表视觉一致。 */}
              {catalog.groups.length > 1 && <SelectLabel>{group.providerName}</SelectLabel>}
              {group.models.map((entry) => (
                <SelectItem key={entry.id} value={entry.model}>
                  {entry.displayName}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {configuredSelected ? (
        <span className="text-ui-sm text-muted-foreground" title={text.configuredHelp}>
          {text.effort}: {selection?.options?.reasoningLevel ?? text.nativeDefault}
        </span>
      ) : (
        <Select
          value={selection?.options?.reasoningLevel ?? ""}
          disabled={locked || !model}
          onValueChange={(value) => {
            if (model && !locked)
              // provider 跟随当前选择的实际归属组（选择解析时已按 catalog 映射治愈）。
              onSelectThought(value, {
                provider: selection?.providerId ?? catalog.providerId,
                model: model.model,
              });
          }}
        >
          <SelectTrigger aria-label={text.effort} className="h-7 max-w-40 text-ui-sm">
            <SelectValue placeholder={text.effort} />
          </SelectTrigger>
          <SelectContent>
            {model?.supportedReasoningEfforts.map((entry) => (
              <SelectItem key={entry.reasoningEffort} value={entry.reasoningEffort}>
                {entry.reasoningEffort}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button size="sm" variant="ghost" onClick={read.reload} disabled={disabled}>
        {text.refresh}
      </Button>
      {busy && (
        <span role="status" className="text-ui-sm text-muted-foreground">
          {text.busySettings}
        </span>
      )}
    </div>
  );
}
