import { useMemo, type ReactNode } from "react";
import {
  BotIcon,
  CpuIcon,
  FileTextIcon,
  GoalIcon,
  LightbulbIcon,
  Minimize2Icon,
  PlusIcon,
  ShieldCheckIcon,
  SquareSlashIcon,
  WandSparklesIcon,
  WorkflowIcon,
} from "lucide-react";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { PromptInputSuggestionItem } from "@/lib/promptInputTriggers.js";
import { isAppSlashCommandSuggestion } from "@/slashCommandHelpers.js";
import {
  type MentionPanelOption,
  type MentionPanelSection,
} from "@/mentions/components/MentionPanel.js";

const BUILTIN_SLASH_MESSAGE_IDS: Readonly<
  Record<string, { labelId: string; descriptionId: string }>
> = {
  model: {
    labelId: "chat.slash.command.model.label",
    descriptionId: "chat.slash.command.model.description",
  },
  mode: {
    labelId: "chat.slash.command.mode.label",
    descriptionId: "chat.slash.command.mode.description",
  },
  plan: {
    labelId: "chat.slash.command.plan.label",
    descriptionId: "chat.slash.command.plan.description",
  },
  init: {
    labelId: "chat.slash.command.init.label",
    descriptionId: "chat.slash.command.init.description",
  },
  compact: {
    labelId: "chat.slash.command.compact.label",
    descriptionId: "chat.slash.command.compact.description",
  },
  goal: {
    labelId: "chat.slash.command.goal.label",
    descriptionId: "chat.slash.command.goal.description",
  },
  workflow: {
    labelId: "chat.slash.command.workflow.label",
    descriptionId: "chat.slash.command.workflow.description",
  },
  side: {
    labelId: "chat.slash.command.side.label",
    descriptionId: "chat.slash.command.side.description",
  },
  btw: {
    labelId: "chat.slash.command.btw.label",
    descriptionId: "chat.slash.command.btw.description",
  },
};

function resolveSlashCommandIcon(value: string): ReactNode {
  switch (value.toLowerCase()) {
    case "model":
      return <CpuIcon className="size-4 shrink-0 text-foreground-subtle" />;
    case "mode":
      return <ShieldCheckIcon className="size-4 shrink-0 text-foreground-subtle" />;
    case "plan":
      return <LightbulbIcon className="size-4 shrink-0 text-foreground-subtle" />;
    case "init":
      return <FileTextIcon className="size-4 shrink-0 text-foreground-subtle" />;
    case "compact":
      return <Minimize2Icon className="size-4 shrink-0 text-foreground-subtle" />;
    case "goal":
      return <GoalIcon className="size-4 shrink-0 text-foreground-subtle" />;
    case "workflow":
      return <WorkflowIcon className="size-4 shrink-0 text-foreground-subtle" />;
    case "side":
    case "btw":
      return <PlusIcon className="size-4 shrink-0 text-foreground-subtle" />;
    default:
      return <SquareSlashIcon className="size-4 shrink-0 text-foreground-subtle" />;
  }
}

export function useSlashCommandMentionPanelSections(
  intl: IntlInstance,
  commandsLength: number,
  filteredCommandSuggestions: PromptInputSuggestionItem[],
  filteredSkillSuggestions: PromptInputSuggestionItem[],
  skillsLoading: boolean,
  skillsError: string | null,
  filteredSubagentSuggestions: PromptInputSuggestionItem[],
  subagentsLoading: boolean,
  subagentsError: string | null,
): MentionPanelSection[] {
  return useMemo(
    () => [
      {
        id: "commands",
        title: intl.formatMessage({ id: "chat.slash.commands.title" }),
        options: filteredCommandSuggestions.map<MentionPanelOption>((suggestion) => {
          const messageIds = BUILTIN_SLASH_MESSAGE_IDS[suggestion.value.toLowerCase()];
          const displayLabel = messageIds
            ? intl.formatMessage({ id: messageIds.labelId })
            : `/${suggestion.value}`;
          const displayDescription = messageIds
            ? intl.formatMessage({ id: messageIds.descriptionId })
            : suggestion.description;
          return {
            id: suggestion.id,
            label: displayLabel,
            description: displayDescription,
            content: (
              <span className="min-w-0 flex-1 flex items-center gap-2.5">
                {resolveSlashCommandIcon(suggestion.value)}
                <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                  {displayLabel}
                </span>
                <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                  {displayDescription}
                </span>
              </span>
            ),
          };
        }),
        loading: false,
        emptyText:
          commandsLength === 0
            ? intl.formatMessage({ id: "chat.slash.emptyUnavailable" })
            : intl.formatMessage({ id: "chat.slash.emptyResults" }),
      },
      {
        id: "skills",
        title: intl.formatMessage({ id: "chat.slash.skills.title" }),
        options: filteredSkillSuggestions.map<MentionPanelOption>((suggestion) => ({
          id: suggestion.id,
          label: `$${suggestion.value}`,
          description: suggestion.description,
          content: (
            <span className="min-w-0 flex-1 flex items-center gap-2.5">
              <WandSparklesIcon className="size-4 shrink-0 text-foreground-subtle" />
              <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                {`$${suggestion.value}`}
              </span>
              <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                {suggestion.description}
              </span>
            </span>
          ),
        })),
        loading: skillsLoading,
        loadingText: intl.formatMessage({ id: "chat.mention.category.loading" }),
        emptyText: intl.formatMessage({ id: "chat.slash.skills.empty" }),
        errorText: skillsError,
      },
      {
        id: "subagents",
        title: intl.formatMessage({ id: "chat.slash.subagents.title" }),
        options: filteredSubagentSuggestions.map<MentionPanelOption>((suggestion) => ({
          id: suggestion.id,
          label: suggestion.value,
          description: suggestion.description,
          content: (
            <span className="min-w-0 flex-1 flex items-center gap-2.5">
              <BotIcon className="size-4 shrink-0 text-foreground-subtle" />
              <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                {suggestion.value}
              </span>
              <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                {suggestion.description}
              </span>
            </span>
          ),
        })),
        loading: subagentsLoading,
        emptyText: intl.formatMessage({ id: "chat.slash.subagents.empty" }),
        errorText: subagentsError,
      },
    ],
    [
      commandsLength,
      filteredCommandSuggestions,
      filteredSkillSuggestions,
      filteredSubagentSuggestions,
      intl,
      skillsError,
      skillsLoading,
      subagentsError,
      subagentsLoading,
    ],
  );
}
