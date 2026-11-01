// 浏览器验收夹具：真实对话框、纯合成数据，不调用生产删除接口。
import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { ProjectRemovalDialog } from "../ProjectRemovalDialog.js";
import type { ProjectManagementRow } from "../project-management-view.js";
import type { ProjectDataTotals, ProjectRemovalOptions } from "../useProjectManagement.js";
import "@/styles.css";

const candidates = (id: string): ProjectManagementRow[] => [
  {
    key: `local:${id}`,
    sessions: 2,
    lastActiveAt: 0,
    removal: "delete",
    project: {
      id,
      hostId: "local",
      name: id,
      nameOverridden: false,
      roots: [{ rootPath: "/synthetic/project", position: 0, isPrimary: true }],
      position: 0,
      pinned: false,
      deleted: false,
      createdAt: 0,
      updatedAt: 0,
    },
  },
];
const totals: ProjectDataTotals = {
  projects: 1,
  sessions: 2,
  sessionBytes: 100,
  checkpointBytes: 0,
  memoryBytes: 0,
  totalBytes: 100,
};

function Fixture() {
  const [rows, setRows] = useState<ProjectManagementRow[] | null>(null);
  const lastRows = useRef<ProjectManagementRow[] | null>(null);
  const [mode, setMode] = useState("error");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const release = useRef<(() => void) | null>(null);
  const [calls, setCalls] = useState(0);
  const [confirmed, setConfirmed] = useState<ProjectRemovalOptions | null>(null);
  const measure = useCallback(async () => {
    setCalls((value) => value + 1);
    const selected = modeRef.current;
    if (selected === "held")
      await new Promise<void>((resolve) => {
        release.current = resolve;
      });
    if (selected === "error") throw new Error("private error not rendered");
    if (selected === "unsupported") return null;
    if (selected === "empty") return { ...totals, sessions: 0, sessionBytes: 0, totalBytes: 0 };
    return totals;
  }, []);
  return (
    <>
      <div className="flex flex-wrap gap-2 p-4">
        {["error", "unsupported", "empty", "available", "held"].map((value) => (
          <Button
            key={value}
            onClick={() => {
              setMode(value);
              lastRows.current = candidates(value);
              setRows(lastRows.current);
            }}
          >
            Open {value}
          </Button>
        ))}
        <Button
          onClick={() => {
            modeRef.current = "available";
            setMode("available");
          }}
        >
          Next measurement succeeds
        </Button>
        <Button onClick={() => release.current?.()}>Release held</Button>
        <Button
          onClick={() => {
            setRows(candidates("new-error"));
            modeRef.current = "error";
            setMode("error");
          }}
        >
          Replace batch
        </Button>
        <Button onClick={() => setRows(null)}>Close fixture</Button>
        <Button onClick={() => setRows(lastRows.current)}>Reopen same batch</Button>
        <pre data-testid="removal-evidence">{JSON.stringify({ calls, confirmed })}</pre>
      </div>
      <ProjectRemovalDialog
        rows={rows}
        measureData={measure}
        onCancel={() => setRows(null)}
        onConfirm={(_, options) => {
          setConfirmed(options ?? {});
          setRows(null);
        }}
      />
    </>
  );
}
const query = new URLSearchParams(location.search);
const dark = query.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.classList.toggle("theme-zai-dark", dark);
document.documentElement.classList.toggle("theme-zai-light", !dark);
document.documentElement.setAttribute("data-codez-browser-theme-surface", dark ? "dark" : "light");
createRoot(document.getElementById("root")!).render(
  <CodezIntlProvider initialLocale={query.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
    <Fixture />
  </CodezIntlProvider>,
);
