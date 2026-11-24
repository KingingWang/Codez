import { describe, expect, it } from "vitest";
import { resolveDefaultEmbeddedSearchBackend } from "../src/app/embedded-search-backend.js";

describe("resolveDefaultEmbeddedSearchBackend", () => {
  it("uses bundled bfs, ugrep, and ripgrep paths by default", () => {
    expect(
      resolveDefaultEmbeddedSearchBackend({
        env: {
          CODEZ_BFS_BINARY: "/opt/codez/tools/bfs/bfs",
          CODEZ_RG_BINARY: "/opt/codez/tools/ripgrep/rg",
          CODEZ_UGREP_BINARY: "/opt/codez/tools/ugrep/ugrep",
        },
      }),
    ).toEqual({
      kind: "native-binaries",
      findCommand: "/opt/codez/tools/bfs/bfs",
      grepCommand: "/opt/codez/tools/ugrep/ugrep",
      rgCommand: "/opt/codez/tools/ripgrep/rg",
    });
  });

  it("falls back to bfs, ugrep, and rg command names when bundled paths are unavailable", () => {
    expect(resolveDefaultEmbeddedSearchBackend({ env: {} })).toEqual({
      kind: "native-binaries",
      findCommand: "bfs",
      grepCommand: "ugrep",
      rgCommand: "rg",
    });
  });

  it("preserves the explicit internal CLI compatibility override", () => {
    expect(
      resolveDefaultEmbeddedSearchBackend({
        env: { CODEZ_EMBEDDED_SEARCH_COMMAND: "/tmp/codez-test" },
      }),
    ).toEqual({
      kind: "internal-cli",
      command: "/tmp/codez-test",
      args: ["__internal-search"],
    });
  });
});
