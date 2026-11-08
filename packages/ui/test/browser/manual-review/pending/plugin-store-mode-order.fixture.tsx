import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IBroadcastService, IServiceAccessor } from "@codez/services";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import { StoreContext } from "@/store/StoreProvider.js";
import { createCodezStore } from "@/store/index.js";
import { PluginStoreListView, type PluginStoreSegment } from "@/settings/PluginStoreListView.js";
import { PluginStoreDetailView } from "@/settings/PluginStoreDetailView.js";
import { buildStoreItems, type StorePluginItem } from "@/settings/pluginStoreListing.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const broadcast: IBroadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
  acquireClaim: async () => ({ status: "unavailable" }),
  commitClaim: async () => {},
  releaseClaim: async () => {},
  tryClaim: async () => false,
};
const store = createCodezStore(broadcast);
store.getState().setInterfaceMode("coding");
store.getState().setTheme(params.get("theme") === "light" ? "light" : "dark");
const official = "codez-plugins-official";
function item(name: string, category: string, marketplace = official): StorePluginItem {
  return {
    id: `${name}@${marketplace}`,
    name,
    marketplace,
    installed: false,
    restorable: false,
    orphaned: false,
    listing: { category },
  };
}
const defaultItems =
  params.get("documentOrder") === "1"
    ? ["aaa", "documents", "spreadsheets", "presentations", "pdf"].map((name) => ({
        ...item(name, "productivity"),
        installed: true,
      }))
    : params.get("missingConfig") === "1"
      ? buildStoreItems({
          marketplaces: [],
          marketplaceAvailabilityKnown: true,
          installedPlugins: [],
          restorableBuiltins: [],
          availablePlugins: [
            "plugin-creator",
            "documents",
            "pdf",
            "presentations",
            "spreadsheets",
            "image-search",
            "repairable",
          ].map((name) => ({
            id: `${name}@${official}`,
            name,
            marketplace: official,
            installed: name !== "repairable",
            listing: { category: "productivity" },
          })),
          plugins: ["document-skills", "repairable"].map((name) => ({
            id: `${name}@${official}`,
            name,
            marketplace: official,
            enabled: true,
            source: "missing" as const,
            packageStatus: "missing" as const,
            rootPath: "",
            skillCount: 0,
            skillRootCount: 0,
            commandRootCount: 0,
            components: [],
            declaredMcpServerNames: [],
            mcpServerNames: [],
            enabledSource: "user" as const,
          })),
        })
      : [
          item("dev", "developer-tools"),
          item("other", "other"),
          item("legacy-guide", "guides"),
          { ...item("restore-legacy-sessions", "utilities"), installed: true },
          ...(params.get("retired") === "1"
            ? [item("restore-legacy-sessions", "utilities", "personal")]
            : []),
          ...(params.get("legal") === "1" ? [item("legal-example", "legal")] : []),
          ...Array.from({ length: 8 }, (_, i) => item(`p${i}`, "productivity")),
          item("personal-b", "productivity", "personal"),
          item("personal-a", "productivity", "personal"),
        ];
const items =
  params.get("uiGroups") === "1"
    ? ["public", "community", "personal"].flatMap((segment) => {
        const marketplace = segment === "personal" ? "personal" : official;
        return Array.from({ length: 9 }, (_, index) => {
          const entry = item(
            `${segment}-${index < 8 ? `panel-${index}` : "regular"}`,
            "utilities",
            marketplace,
          );
          return {
            ...entry,
            listing: {
              ...entry.listing,
              publisherType:
                segment === "community" ? ("community" as const) : ("official" as const),
            },
            summary: {
              id: entry.id,
              name: entry.name,
              marketplace,
              installed: false,
              componentTypes: index < 8 ? ["ui" as const] : [],
            },
          };
        });
      })
    : defaultItems;
let requests = 0;
const services = {
  clientConfigService: {
    getSnapshot: async () => {
      requests += 1;
      const response = await fetch("/order");
      if (!response.ok) throw new Error("offline");
      return { pluginStoreOrder: await response.json() };
    },
  },
} as unknown as IServiceAccessor;

function Fixture() {
  const { order, refresh } = usePluginStoreOrder();
  const [query, setQuery] = useState("");
  const [segment, setSegment] = useState<PluginStoreSegment>("public");
  const [enabled, setEnabled] = useState(true);
  const [action, setAction] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const visibleItems =
    params.get("installedActions") === "1"
      ? [
          {
            ...item("installed-example", "productivity"),
            installed: true,
            info: { id: `installed-example@${official}`, name: "installed-example", enabled },
          } as StorePluginItem,
          item("new-example", "productivity"),
        ]
      : params.get("compatibility") === "1"
        ? [
            {
              ...item("official-incompatible", "productivity"),
              installationUnavailableReason: "backend incompatible reason",
              listing: {
                category: "productivity",
                examplePrompts: ["Install me from the incompatible detail"],
              },
            },
            {
              ...item("official-warning", "productivity"),
              summary: {
                id: `official-warning@${official}`,
                name: "official-warning",
                marketplace: official,
                installed: false,
                officialWarnings: ["backend capability warning"],
              },
            },
          ]
        : items;
  const detail = visibleItems.find((entry) => entry.id === detailId);
  const actions = {
    onOpenDetail: (id: string) => {
      setAction("detail");
      setDetailId(id);
    },
    onUpdate: () => {},
    onInstall: () => setAction("install"),
    onUninstall: () => setAction("uninstall"),
    onSetEnabled: (_id: string, next: boolean) => setEnabled(next),
    activeOperations: [],
    togglingPluginId: null,
  };
  return (
    <main className="@container/plugin-store min-h-screen bg-background p-4 text-foreground">
      <button data-testid="code" onClick={() => store.getState().setInterfaceMode("coding")}>
        Code
      </button>
      <button data-testid="work" onClick={() => store.getState().setInterfaceMode("general")}>
        Work
      </button>
      <button data-testid="refresh" onClick={() => void refresh(true)}>
        Refresh
      </button>
      <output data-testid="requests">{requests}</output>
      <output data-testid="last-action">{action}</output>
      <button data-testid="back-to-list" onClick={() => setDetailId(null)}>
        Back
      </button>
      {detail ? (
        <PluginStoreDetailView
          item={detail}
          actions={actions}
          onRetryDescribe={() => {}}
          onUsePrompt={(entry) => setAction(entry.installed ? "prompt" : "install")}
        />
      ) : (
        <PluginStoreListView
          items={visibleItems}
          order={order}
          marketplaces={[
            {
              id: official,
              name: official,
              source: {},
              pluginCount: 10,
              featured: ["p1", "restore-legacy-sessions", "p0"],
            },
          ]}
          loading={false}
          query={query}
          onQueryChange={setQuery}
          segment={segment}
          onSegmentChange={setSegment}
          actions={actions}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <StoreContext.Provider value={store}>
      <CodezIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
        <TooltipProvider>
          <Fixture />
        </TooltipProvider>
      </CodezIntlProvider>
    </StoreContext.Provider>
  </ServiceProvider>,
);
