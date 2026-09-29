import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { LightbulbIcon, XIcon, ChevronDownIcon } from "lucide-react";
import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODE_SELECT_ITEM,
  TID_V4_COMPOSER_INPUT,
  CODEZ_AGENT_PROVIDER,
  getCodezAgentAvailableModes,
  getCodexPermissionModes,
  testId,
  type CodezConfigOption,
  type CodezTaskModeInfo,
} from "@codez/shared";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  getModeOptionDisplayLabel,
  getModeOptionDescriptionMessageId,
  resolveModeOptionIcon,
} from "@/chat-input-toolbar/display.js";
import {
  CODEX_MODE_OPTION_DESCRIPTION_IDS,
  CODEX_MODE_OPTION_LABEL_IDS,
} from "@/chat-input-toolbar/display-help.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useAlertDialogStore } from "@/store/alertDialogStore.js";
import {
  readCodexFullAccessAcknowledged,
  writeCodexFullAccessAcknowledged,
} from "@/v4/composer/codexFullAccessAcknowledgement.js";
import {
  getNextConfigSelectValue,
  useToolbarShortcutBindings,
} from "@/v4/composer/toolbarShortcuts.js";
import type { V4ComposerToolbarProps } from "@/v4/composer/V4ComposerToolbar.js";

function noop(): void {}

/** Plan 是独立勾选项，权限档位仍为单选；只编辑草稿，不向 Runtime 发切换命令。 */
function V4ComposerModeSwitchImpl({
  provider,
  draftConfig,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSwitchMode,
  codexPermissions = false,
  codexAutoReviewSupported = false,
}: Pick<
  V4ComposerToolbarProps,
  | "workspacePath"
  | "workspaceIdentity"
  | "provider"
  | "draftConfig"
  | "disabled"
  | "activeConfigPicker"
  | "onConfigPickerOpenChange"
  | "onSwitchMode"
  | "codexPermissions"
  | "codexAutoReviewSupported"
>) {
  const { intl } = useCodezIntl();
  const displayProvider = provider ?? CODEZ_AGENT_PROVIDER;
  const modeShortcutLabel = useShortcutCommandLabel("cycleSessionMode");
  const requestAlert = useAlertDialogStore((state) => state.requestAlert);
  // Codex 会话使用与原生权限菜单一一对应的档位目录（specs/codex-permission-modes.md）；
  // edit（帮我审批）由 autoReviewApprovals 能力门控，能力未确认即隐藏（fail-closed）。
  const permissions = useMemo<CodezTaskModeInfo[]>(
    () =>
      codexPermissions
        ? getCodexPermissionModes().filter((mode) => mode.id !== "edit" || codexAutoReviewSupported)
        : getCodezAgentAvailableModes().filter((mode) => mode.id !== "plan"),
    [codexPermissions, codexAutoReviewSupported],
  );
  const selected =
    permissions.find((mode) => mode.id === draftConfig?.mode) ??
    // 草稿值未命中目录（如 edit 被能力门控隐藏、运行时切换残留 custom）时回退默认档
    // 展示，与提交归一化保持一致（Codex=custom，Codez Agent=build），避免菜单消失。
    permissions.find((mode) => mode.id === (codexPermissions ? "custom" : "build"));
  const label = useCallback(
    (mode: CodezTaskModeInfo) => {
      const codexLabelId = codexPermissions ? CODEX_MODE_OPTION_LABEL_IDS[mode.id] : undefined;
      return codexLabelId
        ? intl.formatMessage({ id: codexLabelId })
        : getModeOptionDisplayLabel(intl, displayProvider, { value: mode.id, name: mode.name });
    },
    [codexPermissions, displayProvider, intl],
  );
  const descriptionId = useCallback(
    (id: string): string | null =>
      codexPermissions
        ? (CODEX_MODE_OPTION_DESCRIPTION_IDS[id] ?? null)
        : getModeOptionDescriptionMessageId(displayProvider, { value: id }),
    [codexPermissions, displayProvider],
  );
  // Plan 勾选框：Codex 使用独立文案（planEnabled/collaborationMode 维度，与权限档位正交）。
  const planLabel = codexPermissions
    ? intl.formatMessage({ id: "mode.plan" })
    : label(getCodezAgentAvailableModes().find((mode) => mode.id === "plan")!);
  const planDescriptionId = descriptionId("plan");
  // 确认弹窗是异步 Promise：组件卸载或 Codex 权限面消失后，迟到的确认不得再写入
  // 旧作用域的草稿（把 yolo 写回已切换走的 scope）。模态已挡住指针交互，这里兜底
  // 卸载与权限面变化两类失效。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const codexPermissionsRef = useRef(codexPermissions);
  codexPermissionsRef.current = codexPermissions;
  /** 完全访问首次选择需确认；确认后持久化，不再重复弹（spec UI 约束）。 */
  const handleSelectPermission = useCallback(
    (value: string) => {
      if (!codexPermissions || value !== "yolo" || readCodexFullAccessAcknowledged()) {
        onSwitchMode(value);
        return;
      }
      void requestAlert({
        title: intl.formatMessage({ id: "mode.codex.yolo.confirm.title" }),
        description: intl.formatMessage({ id: "mode.codex.yolo.confirm.description" }),
        actionLabel: intl.formatMessage({ id: "mode.codex.yolo.confirm.accept" }),
      }).then((confirmed) => {
        if (!confirmed || !mountedRef.current || !codexPermissionsRef.current) return;
        writeCodexFullAccessAcknowledged();
        onSwitchMode("yolo");
      });
    },
    [codexPermissions, intl, onSwitchMode, requestAlert],
  );
  const modeOption = useMemo<CodezConfigOption>(
    () => ({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: selected?.id ?? (codexPermissions ? "custom" : "build"),
      options: permissions.map((mode) => ({ value: mode.id, name: mode.name })),
    }),
    [codexPermissions, permissions, selected?.id],
  );
  const cycle = useCallback(() => {
    const next = getNextConfigSelectValue(modeOption);
    if (next) handleSelectPermission(next);
  }, [handleSelectPermission, modeOption]);
  useToolbarShortcutBindings({
    hasAnyOption: Boolean(selected),
    toolbarDisabled: disabled,
    modelMenuDisabled: true,
    modeOption,
    onCycleSessionMode: cycle,
    onOpenModelMenu: noop,
    onCycleThoughtLevel: noop,
  });
  if (!selected) return null;
  const Icon = resolveModeOptionIcon(selected.id);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <DropdownMenu
        open={activeConfigPicker === "mode"}
        onOpenChange={(open) => onConfigPickerOpenChange("mode", open)}
      >
        <ControlHintTooltip
          title={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
          shortcut={modeShortcutLabel}
          open={activeConfigPicker === "mode" ? false : undefined}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid={TID_CHAT_MODE_SELECT_TRIGGER}
              data-composer-collapse-priority="1"
              aria-label={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
              className={cn(
                "group/mode h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
                selected.id === "yolo" && "text-warning hover:text-warning",
              )}
            >
              <Icon className="size-4" />
              <span className="inline group-data-[composer-compact=true]/mode:hidden">
                {label(selected)}
              </span>
              <ChevronDownIcon className="size-3.5 group-data-[composer-compact=true]/mode:hidden" />
            </Button>
          </DropdownMenuTrigger>
        </ControlHintTooltip>
        <DropdownMenuContent
          side="top"
          sideOffset={4}
          className="w-64"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!isCoarseTouchDevice())
              document
                .querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
                ?.focus();
          }}
        >
          <DropdownMenuCheckboxItem
            checked={draftConfig?.planEnabled ?? false}
            onCheckedChange={(checked) => onSwitchMode(checked ? "plan" : "plan-off")}
            data-testid={testId(TID_CHAT_MODE_SELECT_ITEM, "plan")}
            className="min-h-13 items-start gap-3 py-2"
          >
            <LightbulbIcon className="mt-0.5 size-4.5 shrink-0" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{planLabel}</span>
              {planDescriptionId && (
                <span className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: planDescriptionId })}
                </span>
              )}
            </span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={selected.id} onValueChange={handleSelectPermission}>
            {permissions.map((mode) => {
              const ModeIcon = resolveModeOptionIcon(mode.id);
              const modeDescriptionId = descriptionId(mode.id);
              return (
                <DropdownMenuRadioItem
                  key={mode.id}
                  value={mode.id}
                  data-testid={testId(TID_CHAT_MODE_SELECT_ITEM, mode.id)}
                  className={cn(
                    "min-h-13 items-start gap-3 py-2",
                    mode.id === "yolo" && "text-warning data-[highlighted]:text-warning",
                  )}
                >
                  <ModeIcon className="mt-0.5 size-4.5 shrink-0" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>{label(mode)}</span>
                    {modeDescriptionId && (
                      <span className="text-ui-sm text-foreground-subtle">
                        {intl.formatMessage({ id: modeDescriptionId })}
                      </span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {draftConfig?.planEnabled && (
        <span data-testid="v4-composer-plan-marker" className="flex items-center gap-1">
          <span
            role="separator"
            aria-orientation="vertical"
            className="h-3 w-px shrink-0 bg-border"
          />
          <ControlHintTooltip title={intl.formatMessage({ id: "chat.plan.removeMarker" })}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-composer-collapse-priority="2"
              onClick={() => onSwitchMode("plan-off")}
              aria-label={intl.formatMessage({ id: "chat.plan.removeMarker" })}
              className="group/plan h-7 gap-1 rounded-lg px-2 text-ui-base text-foreground-subtle hover:text-foreground-subtle data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0"
            >
              <LightbulbIcon className="size-4 group-hover/plan:hidden group-focus-visible/plan:hidden" />
              <XIcon className="hidden size-4 group-hover/plan:block group-focus-visible/plan:block" />
              <span className="inline group-data-[composer-compact=true]/plan:hidden">
                {intl.formatMessage({ id: "mode.plan" })}
              </span>
            </Button>
          </ControlHintTooltip>
        </span>
      )}
    </div>
  );
}
export const V4ComposerModeSwitch = memo(V4ComposerModeSwitchImpl);
