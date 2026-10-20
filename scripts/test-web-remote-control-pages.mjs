import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../packages/web/dist/", import.meta.url));
const PAGE_BASE = "/Codez/remote/v4/";

test("GitHub Pages mobile entry only references bundled resources under its project route", async () => {
  const html = await readFile(join(DIST, "index.html"), "utf8");
  assert.match(html, /<meta name="referrer" content="no-referrer"/u);

  const resources = [...html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)="([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((url) => !url.startsWith("data:"));
  assert.ok(resources.some((url) => url.endsWith(".js")));
  assert.ok(resources.some((url) => url.endsWith(".css")));

  for (const resource of resources) {
    // GitHub Pages 的项目路径不是域名根；漏掉此前缀会使手机首屏加载失败。
    assert.ok(resource.startsWith(PAGE_BASE), `unexpected external or root resource: ${resource}`);
    const target = join(DIST, resource.slice(PAGE_BASE.length));
    assert.ok((await stat(target)).isFile(), `missing bundled resource: ${resource}`);
  }

  assert.ok((await stat(join(DIST, "pdfjs/cmaps/UniGB-UTF16-H.bcmap"))).isFile());
  assert.ok((await stat(join(DIST, "material-icons/typescript.svg"))).isFile());
});
