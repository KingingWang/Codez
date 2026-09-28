import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type IMemoryService, type ProjectMemoryWorkspaceSummary } from "@codez/services";
import { completeNewModelSelection } from "@codez/provider";
import {
  CODEZ_AGENT_PROVIDER,
  TID_SETTINGS_MEMORY_EXTRACTION_MODEL,
  TID_SETTINGS_MEMORY_EXTRACTION_SWITCH,
  TID_SETTINGS_MEMORY_SWITCH,
  TID_SETTINGS_MEMORY_USE_SWITCH,
  type ModelSelection,
} from "@codez/shared";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { Switch } from "@/components/ui/switch.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { ModelConfigSelect, type ModelSelectFooterAction } from "@/ModelConfigSelect.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { encodeCustomModelValue } from "@/lib/codezCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/codezSessionProjection.js";
import {
  buildRegistryModelSelectGroups,
  resolveModelDisplayName,
} from "@/lib/modelSelectionGroups.js";
import {
  MemorySettingsViewer,
  type MemoryViewerLoadingState,
} from "@/settings/MemorySettingsViewer.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

const FOLLOW_SESSION_MODEL_VALUE = "follow-session-model";

type MemoryCatalogService = Pick<IMemoryService, "listProjectMemories">;

function normalizeWorkspaceDisplayName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

function buildWorkspaceDisplayNameMap(names: readonly string[]): ReadonlyMap<string, string> {
  const matches = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const candidate of names) {
    const displayName = candidate.trim();
    const slug = normalizeWorkspaceDisplayName(displayName);
    if (!displayName || !slug || ambiguous.has(slug)) continue;
    const existing = matches.get(slug);
    if (existing && existing !== displayName) {
      matches.delete(slug);
      ambiguous.add(slug);
      continue;
    }
    matches.set(slug, displayName);
  }
  return matches;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MemorySettingsSection({
  memoryEnabled,
  memoryUseEnabled,
  memoryExtractionEnabled,
  memoryExtractionModel,
  memoryService,
  onMemoryEnabledChange,
  onMemoryUseEnabledChange,
  onMemoryExtractionEnabledChange,
  onMemoryExtractionModelChange,
  projectMemoryViewerAvailable,
  workspaceDisplayNames = [],
}: {
  memoryEnabled: boolean;
  memoryUseEnabled: boolean;
  memoryExtractionEnabled: boolean;
  memoryExtractionModel: ModelSelection | null;
  memoryService: MemoryCatalogService;
  onMemoryEnabledChange: (enabled: boolean) => Promise<void>;
  onMemoryUseEnabledChange: (enabled: boolean) => Promise<void>;
  onMemoryExtractionEnabledChange: (enabled: boolean) => Promise<void>;
  onMemoryExtractionModelChange: (model: ModelSelection | null) => Promise<void>;
  projectMemoryViewerAvailable: boolean;
  workspaceDisplayNames?: readonly string[];
}) {
  const { intl } = useCodezIntl();
  const catalogRequestIdRef = useRef(0);
  const [catalogState, setCatalogState] = useState<MemoryViewerLoadingState>("idle");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<ProjectMemoryWorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  const refreshCatalog = useCallback(async (): Promise<ProjectMemoryWorkspaceSummary[] | null> => {
    const requestId = catalogRequestIdRef.current + 1;
    catalogRequestIdRef.current = requestId;
    setCatalogState("loading");
    setCatalogError(null);
    try {
      const result = await memoryService.listProjectMemories();
      if (catalogRequestIdRef.current !== requestId) {
        return null;
      }
      setWorkspaces(result);
      setCatalogState("ready");
      return result;
    } catch (error) {
      if (catalogRequestIdRef.current !== requestId) {
        return null;
      }
      setWorkspaces([]);
      setSelectedWorkspaceId(null);
      setCatalogError(getErrorMessage(error));
      setCatalogState("error");
      return null;
    }
  }, [memoryService]);

  useEffect(() => {
    if (memoryEnabled && projectMemoryViewerAvailable) {
      void refreshCatalog();
      return;
    }

    catalogRequestIdRef.current += 1;
    setCatalogState("idle");
    setCatalogError(null);
    setWorkspaces([]);
    setSelectedWorkspaceId(null);
  }, [memoryEnabled, projectMemoryViewerAvailable, refreshCatalog]);

  const displayWorkspaces = useMemo(() => {
    const displayNameBySlug = buildWorkspaceDisplayNameMap(workspaceDisplayNames);
    const orderBySlug = new Map<string, number>();
    for (const [index, name] of workspaceDisplayNames.entries()) {
      const slug = normalizeWorkspaceDisplayName(name);
      if (!orderBySlug.has(slug)) orderBySlug.set(slug, index);
    }
    return workspaces
      .map((workspace, catalogIndex) => {
        const slug = normalizeWorkspaceDisplayName(workspace.label);
        return {
          catalogIndex,
          order: orderBySlug.get(slug) ?? Number.POSITIVE_INFINITY,
          workspace: {
            ...workspace,
            label: displayNameBySlug.get(slug) ?? workspace.label,
          },
        };
      })
      .sort((left, right) => left.order - right.order || left.catalogIndex - right.catalogIndex)
      .map(({ workspace }) => workspace);
  }, [workspaceDisplayNames, workspaces]);
  const selectedWorkspace = useMemo(
    () => displayWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId),
    [displayWorkspaces, selectedWorkspaceId],
  );

  useEffect(() => {
    const firstWorkspace = displayWorkspaces[0];
    if (!firstWorkspace) {
      setSelectedWorkspaceId(null);
      return;
    }
    if (
      !selectedWorkspaceId ||
      !displayWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)
    ) {
      setSelectedWorkspaceId(firstWorkspace.id);
    }
  }, [displayWorkspaces, selectedWorkspaceId]);

  const handleRefresh = useCallback(async () => {
    await runUserActionAsync({
      input: { featureId: "settings.memory", action: "refresh_memory", trigger: "button" },
      operation: refreshCatalog,
      completed: { resultSource: "platform_result" },
      failureStage: "catalog_refresh",
    });
  }, [refreshCatalog]);

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({
            id: "settings.memory.workspaceMemory",
          })}
          description={intl.formatMessage({
            id: "settings.memoryDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.memory.workspaceMemory",
              })}
              checked={memoryEnabled}
              data-testid={TID_SETTINGS_MEMORY_SWITCH}
              onCheckedChange={(checked) => {
                void onMemoryEnabledChange(checked);
              }}
            />
          }
        />
        {memoryEnabled ? (
          <>
            <SettingsRow
              label={intl.formatMessage({ id: "settings.memory.use" })}
              description={intl.formatMessage({ id: "settings.memory.useDescription" })}
              control={
                <Switch
                  aria-label={intl.formatMessage({ id: "settings.memory.use" })}
                  checked={memoryUseEnabled}
                  data-testid={TID_SETTINGS_MEMORY_USE_SWITCH}
                  onCheckedChange={(checked) => {
                    void onMemoryUseEnabledChange(checked);
                  }}
                />
              }
            />
            <SettingsRow
              label={intl.formatMessage({ id: "settings.memory.extraction" })}
              description={intl.formatMessage({
                id: "settings.memory.extractionDescription",
              })}
              control={
                <Switch
                  aria-label={intl.formatMessage({ id: "settings.memory.extraction" })}
                  checked={memoryExtractionEnabled}
                  data-testid={TID_SETTINGS_MEMORY_EXTRACTION_SWITCH}
                  onCheckedChange={(checked) => {
                    void onMemoryExtractionEnabledChange(checked);
                  }}
                />
              }
            />
            <SettingsRow
              label={intl.formatMessage({ id: "settings.memory.extractionModel" })}
              description={intl.formatMessage({
                id: "settings.memory.extractionModelDescription",
              })}
              control={
                <MemoryExtractionModelSelect
                  extractionModel={memoryExtractionModel}
                  onExtractionModelChange={onMemoryExtractionModelChange}
                />
              }
            />
          </>
        ) : null}
      </SettingsGroupCard>

      {!projectMemoryViewerAvailable ? (
        <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.memory.viewer.localOnly" })}
        </div>
      ) : !memoryEnabled ? null : (
        <MemorySettingsViewer
          catalogError={catalogError}
          catalogState={catalogState}
          selectedWorkspace={selectedWorkspace}
          workspaces={displayWorkspaces}
          onRefresh={handleRefresh}
          onScopeKeyChange={(workspaceId) =>
            runUserAction({
              input: {
                featureId: "settings.memory",
                action: "change_memory_scope",
                trigger: "select",
              },
              operation: () => setSelectedWorkspaceId(workspaceId),
              completed: { resultSource: "local_commit" },
              failureStage: "local_commit",
            })
          }
        />
      )}
    </div>
  );
}

const MEMORY_MODEL_ITEM_NEVER_LOCKED = () => false;

/**
 * 记忆提取模型选择。模型事实只读 Local Host Registry（与 Subagents 设置同一来源）；
 * 「跟随会话模型」落库为 null，运行时由会话模型兜底。
 */
function MemoryExtractionModelSelect({
  extractionModel,
  onExtractionModelChange,
}: {
  extractionModel: ModelSelection | null;
  onExtractionModelChange: (model: ModelSelection | null) => Promise<void>;
}) {
  const { intl } = useCodezIntl();
  // 设置只管理本机环境；模型事实必须读 Local Host，避免远端 workspace 污染本地目录。
  const localHostServices = useBaseWorkspaceServices();
  const modelSelectionRead = useModelSelectionServiceView(localHostServices.modelSelectionService);
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const modelSelectionLoading = modelSelectionRead.state.status !== "ready";
  const modelGroups = useMemo(
    () =>
      modelSelectionView
        ? buildRegistryModelSelectGroups(CODEZ_AGENT_PROVIDER, modelSelectionView, {
            startPlanBadgeLabel: intl.formatMessage({
              id: "settings.modelProvider.connectionMode.startPlanBadge",
            }),
            apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
            codingPlanLabel: intl.formatMessage({
              id: "settings.modelProvider.connectionMode.codingPlan",
            }),
          })
        : [],
    [intl, modelSelectionView],
  );
  const [pending, setPending] = useState(false);
  const followLabel = intl.formatMessage({
    id: "settings.memory.extractionModel.followSession",
  });
  const value = extractionModel
    ? encodeCustomModelValue(extractionModel.providerId, extractionModel.modelId)
    : FOLLOW_SESSION_MODEL_VALUE;
  const modelAvailable =
    value === FOLLOW_SESSION_MODEL_VALUE ||
    modelSelectionLoading ||
    modelGroups.some((group) => group.items.some((item) => item.value === value));
  const triggerLabel =
    value === FOLLOW_SESSION_MODEL_VALUE || !modelAvailable
      ? followLabel
      : (resolveModelDisplayName(modelGroups, value) ?? followLabel);

  const persist = useCallback(
    async (nextValue: string) => {
      if (pending || nextValue === value) return;
      setPending(true);
      try {
        if (nextValue === FOLLOW_SESSION_MODEL_VALUE) {
          await onExtractionModelChange(null);
          return;
        }
        const parsed = parseModelPickerValue(nextValue);
        // 与 Subagent 模型覆盖同一约定：持久化 Registry 默认 reasoning 档位，
        // 不能让界面有值而执行 Selection 缺少 reasoningLevel。
        const selection = modelSelectionView
          ? (completeNewModelSelection(modelSelectionView, parsed) ?? parsed)
          : parsed;
        await onExtractionModelChange(selection);
      } finally {
        setPending(false);
      }
    },
    [modelSelectionView, onExtractionModelChange, pending, value],
  );

  const footerActions = useMemo<ModelSelectFooterAction[]>(
    () => [
      {
        key: "memory-extraction-model:follow-session",
        label: followLabel,
        onSelect: () => void persist(FOLLOW_SESSION_MODEL_VALUE),
        selected: value === FOLLOW_SESSION_MODEL_VALUE,
      },
    ],
    [followLabel, persist, value],
  );

  return (
    <span
      data-testid={TID_SETTINGS_MEMORY_EXTRACTION_MODEL}
      data-model-current-value={value}
      className="inline-flex min-w-0"
    >
      <ModelConfigSelect
        modelGroups={modelGroups}
        normalizedValue={modelAvailable ? value : FOLLOW_SESSION_MODEL_VALUE}
        triggerLabel={triggerLabel}
        showManageModelsAction={false}
        lockReasonMessage=""
        isItemLocked={MEMORY_MODEL_ITEM_NEVER_LOCKED}
        onValueChange={(next) => void persist(next)}
        footerActions={footerActions}
        manageModelsLabel={intl.formatMessage({
          id: "chat.toolbar.model.manageModels",
        })}
        contentSide="top"
        contentAlign="end"
        focusSelectorOnClose={null}
        labelVisibilityClassName="inline-flex min-w-0"
        triggerClassName="h-8 w-fit max-w-52 min-w-0 justify-between rounded-lg border border-input-border bg-input px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
        triggerLabelClassName="inline-flex min-w-0 truncate text-left"
        disabled={pending}
      />
    </span>
  );
}
