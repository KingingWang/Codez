import { useCallback, useMemo, useRef } from "react";
import { RefreshCwIcon } from "lucide-react";
import {
  CODEZ_AGENT_PROVIDER,
  TID_V4_COMPOSER_INPUT,
  type CodezConfigOption,
  type ModelSelection,
} from "@codez/shared";
import type { SessionUsageState } from "@codez/shared/codez-protocol-v4";
import type { CodexModelCatalogRead } from "@/hooks/useCodexModelCatalog.js";
import { Button } from "@/components/ui/button.js";
import { ChatContextUsage } from "@/chat-input-toolbar/contextUsage.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { resolveSessionTaskUsage } from "@/v4/composer/codexSessionUsage.js";
import { resolveV4ModelTriggerDisplay } from "@/v4/composer/modelTriggerDisplay.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";
import { useCodexMessages } from "./messages.js";

const COMPOSER_INPUT_SELECTOR = `[data-testid="${TID_V4_COMPOSER_INPUT}"]`;

// ModelConfigSelect 是 memo 组件，锁谓词必须是稳定引用（仓库 reactStableReferences 约束）。
const NEVER_ITEM_LOCKED = () => false;

export function CodexComposerModelControls({
  read,
  selection,
  disabled,
  busy = false,
  usage = null,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSelectModel,
  onSelectThought,
}: {
  read: CodexModelCatalogRead;
  selection?: ModelSelection;
  disabled: boolean;
  busy?: boolean;
  /** 会话用量投影（codexObserved 稀疏事实）；驱动与旧版一致的上下文占用环。 */
  usage?: SessionUsageState | null;
  /** 与 V4ComposerModelControls 共享的拾取器互斥状态；缺省时菜单自管开关。 */
  activeConfigPicker?: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange?: (picker: V4ComposerConfigPicker, open: boolean) => void;
  onSelectModel(provider: string, model: string, source: null): void;
  onSelectThought(effort: string, context: { provider: string; model: string }): void;
}) {
  const text = useCodexMessages();
  const { intl, locale } = useCodezIntl();
  const catalog = read.catalog;
  const model = catalog?.models.find((candidate) => candidate.model === selection?.modelId);
  const locked = disabled || busy;
  const configured = catalog?.configuredSelection;
  const configuredSelected = configured && configured.modelId === selection?.modelId;
  const modelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);

  const taskUsage = useMemo(() => resolveSessionTaskUsage(usage), [usage]);

  // 目录分组直接映射为共享模型菜单分组；单 provider 时保持扁平列表，
  // 与分组引入前的目录视觉一致（spec：CodexSettings.spec.md）。
  const modelGroups = useMemo<readonly ModelSelectGroup[]>(() => {
    if (!catalog) return [];
    const flat = catalog.groups.length <= 1;
    return catalog.groups.map((group) => ({
      key: group.providerId,
      label: group.providerName,
      ...(flat ? { directItems: true as const } : {}),
      items: group.models.map((entry) => ({
        key: entry.id,
        value: entry.model,
        name: entry.displayName,
      })),
    }));
  }, [catalog]);

  // 显式配置但未进入发现的模型排在菜单首位；值与组内项同口径（裸 model id），
  // 选择归一在 handleModelValueChange 中按 configured 命中还原 provider。
  const leadingItems = useMemo(
    () =>
      configured && !catalog?.models.some((entry) => entry.model === configured.modelId)
        ? [
            {
              key: "codex-configured",
              value: configured.modelId,
              name: `${configured.modelId} · ${text.configured}`,
            },
          ]
        : undefined,
    [catalog, configured, text.configured],
  );

  const normalizedModelValue = selection?.modelId ?? "";
  const selectedOwnerGroup = catalog?.groups.find((group) =>
    group.models.some((entry) => entry.model === selection?.modelId),
  );
  const selectedProviderId = configuredSelected
    ? configured.providerId
    : (selectedOwnerGroup?.providerId ?? catalog?.providerId);
  const selectedProviderName = configuredSelected ? undefined : selectedOwnerGroup?.providerName;
  // 配置模型未进入发现时不在任何分组里：触发器回退为配置事实本身，
  // 不能显示成「默认模型」占位（旧 Select 直接展示 configured.modelId）。
  const configuredMissingFromDiscovery =
    configured && !catalog?.models.some((entry) => entry.model === configured.modelId);
  const triggerDisplay = resolveV4ModelTriggerDisplay({
    modelGroups: modelGroups,
    normalizedValue: normalizedModelValue,
    fallbackLabel:
      configuredSelected && configuredMissingFromDiscovery ? configured.modelId : text.model,
    providerId: selectedProviderId,
    providerName: selectedProviderName,
  });

  // 配置模型未返回能力表时，档位是原生事实而非可选项：单档只读 Pill 与共享控件
  // 的固定档位渲染一致，不伪造能力列表（spec：configuredSelection 语义）。
  const thoughtOption = useMemo<CodezConfigOption | null>(() => {
    const current = selection?.options?.reasoningLevel ?? "";
    if (model) {
      return {
        id: "codex-reasoning-effort",
        name: text.effort,
        type: "select",
        currentValue: current,
        options: model.supportedReasoningEfforts.map((entry) => ({
          value: entry.reasoningEffort,
          name: entry.reasoningEffort,
        })),
      };
    }
    if (configuredSelected && current) {
      return {
        id: "codex-reasoning-effort",
        name: text.effort,
        type: "select",
        currentValue: current,
        options: [{ value: current, name: current }],
      };
    }
    return null;
  }, [configuredSelected, model, selection?.options?.reasoningLevel, text.effort]);

  const handleModelPickerOpenChange = useCallback(
    (open: boolean) => onConfigPickerOpenChange?.("model", open),
    [onConfigPickerOpenChange],
  );

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

  const handleModelValueChange = (value: string) => {
    if (locked) return;
    // configuredSelection 是激活 provider 的配置事实；目录模型按分组归属，
    // providerId 必须跟随模型的实际 catalog provider（执行路由事实）。
    const owner =
      configured && value === configured.modelId
        ? configured.providerId
        : (catalog.groups.find((group) => group.models.some((entry) => entry.model === value))
            ?.providerId ?? catalog.providerId);
    onSelectModel(owner, value, null);
  };

  return (
    <div data-testid="codex-composer-models" className="flex min-w-0 items-center gap-1">
      <ChatContextUsage
        taskUsage={taskUsage}
        selectedProvider={CODEZ_AGENT_PROVIDER}
        intl={intl}
        locale={locale}
      />
      <ModelConfigSelect
        modelGroups={modelGroups}
        normalizedValue={normalizedModelValue}
        triggerLabel={triggerDisplay.fullLabel}
        triggerLabelPrefix={triggerDisplay.providerPrefix}
        triggerLabelValue={triggerDisplay.modelLabel}
        triggerLabelPrefixClassName="composer-provider-prefix inline group-data-[composer-provider-compact=true]/toolbar:hidden"
        showManageModelsAction={false}
        lockReasonMessage={intl.formatMessage({
          id: "chat.toolbar.modelSwitch.lockedByRunningTask",
        })}
        isItemLocked={NEVER_ITEM_LOCKED}
        onValueChange={handleModelValueChange}
        disabled={locked || (modelGroups.length === 0 && !leadingItems?.length)}
        tooltipTitle={triggerDisplay.fullLabel}
        triggerRef={modelTriggerRef}
        open={onConfigPickerOpenChange ? !locked && activeConfigPicker === "model" : undefined}
        onOpenChange={handleModelPickerOpenChange}
        labelVisibilityClassName="hidden @sm/composer:inline-flex"
        indicatorClassName="block group-data-[composer-model-icon=true]/toolbar:hidden"
        triggerLabelClassName="block min-w-0 text-left group-data-[composer-model-icon=true]/toolbar:hidden [&>span]:max-w-full [&>span>span]:block [&>span>span]:truncate"
        triggerClassName="composer-model-trigger group-data-[composer-model-icon=true]/toolbar:size-7 group-data-[composer-model-icon=true]/toolbar:p-0 group-data-[composer-model-icon=true]/toolbar:gap-0 group-data-[composer-model-icon=true]/toolbar:justify-center"
        triggerIconClassName="hidden group-data-[composer-model-icon=true]/toolbar:inline-flex"
        focusSelectorOnClose={COMPOSER_INPUT_SELECTOR}
        leadingItems={leadingItems}
      />
      {thoughtOption ? (
        <ThoughtLevelCycleControl
          composerCollapsePriority={3}
          labelVisibilityClassName="inline-flex"
          indicatorClassName="block"
          option={thoughtOption}
          onValueChange={(value) => {
            if (model && !locked)
              // provider 跟随当前选择的实际归属组（选择解析时已按 catalog 映射治愈）。
              onSelectThought(value, {
                provider: selection?.providerId ?? catalog.providerId,
                model: model.model,
              });
          }}
          disabled={locked || !model}
          intl={intl}
          provider={CODEZ_AGENT_PROVIDER}
          triggerRef={thoughtTriggerRef}
          open={onConfigPickerOpenChange ? !locked && activeConfigPicker === "thought" : undefined}
          onOpenChange={(open) => onConfigPickerOpenChange?.("thought", open)}
          restoreFocusSelector={COMPOSER_INPUT_SELECTOR}
        />
      ) : null}
      <ControlHintTooltip title={text.refresh}>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          aria-label={text.refresh}
          onClick={read.reload}
          disabled={disabled}
          className="shrink-0 text-foreground-subtle hover:text-foreground"
        >
          <RefreshCwIcon className="size-4" />
        </Button>
      </ControlHintTooltip>
    </div>
  );
}
