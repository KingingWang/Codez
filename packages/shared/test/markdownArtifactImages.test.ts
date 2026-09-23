import { describe, expect, it } from "vitest";

import {
  decodeMarkdownArtifactImageSource,
  extractMarkdownArtifactImageRefs,
  rewriteMarkdownArtifactImageSources,
} from "../src/markdown-artifact-images.js";

describe("Markdown artifact image references", () => {
  it("extracts only image destinations and deduplicates them", () => {
    expect(
      extractMarkdownArtifactImageRefs(
        [
          "![first](codez-artifact://session/a)",
          "[download](codez-artifact://session/not-an-image)",
          '![again](<codez-artifact://session/a> "preview")',
          "![second](codez-artifact://session/b 'title')",
        ].join("\n"),
      ),
    ).toEqual(["codez-artifact://session/a", "codez-artifact://session/b"]);
  });

  it("does not authorize image-looking text inside fenced code", () => {
    expect(
      extractMarkdownArtifactImageRefs(
        "```md\n![secret](codez-artifact://session/secret)\n```\n![ok](codez-artifact://session/ok)",
      ),
    ).toEqual(["codez-artifact://session/ok"]);
  });

  it("rewrites artifact image destinations to a harden-safe relative source", () => {
    const rewritten = rewriteMarkdownArtifactImageSources(
      "before ![shot](codez-artifact://session/shot-1) after",
    );
    expect(rewritten).not.toContain("codez-artifact://");
    const source = rewritten.match(/!\[shot\]\(([^)]+)\)/u)?.[1];
    expect(source).toBeTruthy();
    expect(decodeMarkdownArtifactImageSource(source ?? "")).toBe("codez-artifact://session/shot-1");
  });

  it("leaves normal images, links, and fenced examples unchanged", () => {
    const markdown = [
      "![web](https://example.com/image.png)",
      "[artifact](codez-artifact://session/file)",
      "```md",
      "![example](codez-artifact://session/example)",
      "```",
    ].join("\n");
    expect(rewriteMarkdownArtifactImageSources(markdown)).toBe(markdown);
  });
});
