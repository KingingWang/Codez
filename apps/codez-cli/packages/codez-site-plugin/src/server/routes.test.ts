import { describe, expect, it } from "vitest";
import { resourcePath } from "./routes.ts";

const SITE = "1978123456789012480";
const DEP = "1978123456789012481";

describe("resourcePath", () => {
  it.each([
    ["codez-site://usage", "/api/v1/sites/usage"],
    ["codez-site://plans", "/api/v1/sites/plans"],
    ["codez-site://sites", "/api/v1/sites"],
    ["codez-site://sites?cursor=", "/api/v1/sites"],
    [
      "codez-site://sites?cursor=a%2Fb&limit=20",
      "/api/v1/sites?cursor=a%2Fb&limit=20",
    ],
    [`codez-site://sites/${SITE}`, `/api/v1/sites/${SITE}`],
    [
      `codez-site://sites/${SITE}/deployments?cursor=x`,
      `/api/v1/sites/${SITE}/deployments?cursor=x`,
    ],
    [
      `codez-site://sites/${SITE}/deployments/${DEP}`,
      `/api/v1/sites/${SITE}/deployments/${DEP}`,
    ],
    [`codez-site://sites/${SITE}/cover`, `/api/v1/sites/${SITE}/cover`],
    [`codez-site://sites/${SITE}/analytics`, `/api/v1/sites/${SITE}/analytics`],
    [
      `codez-site://sites/${SITE}/analytics?range=30d`,
      `/api/v1/sites/${SITE}/analytics?range=30d`,
    ],
    [
      `codez-site://sites/analytics/pv24h?siteIds=${SITE},${DEP}`,
      `/api/v1/sites/analytics/pv24h?siteIds=${SITE}%2C${DEP}`,
    ],
    [
      `codez-site://sites/${SITE}/deployments/${DEP}/logs?offset=12`,
      `/api/v1/sites/${SITE}/deployments/${DEP}/logs?offset=12`,
    ],
  ])("maps %s", (uri, path) => {
    expect(resourcePath(uri)).toBe(path);
  });

  it.each([
    "codez-site://other",
    "https://sites/1",
    "codez-site://usage?cursor=1",
    "codez-site://plans?limit=1",
    "codez-site://plans/free",
    "codez-site://sites/abc",
    "codez-site://sites/0123",
    "codez-site://sites/1/deployments/2/logs/extra",
    "codez-site://sites/1/cover/2",
    "codez-site://sites/1/cover?offset=1",
    "codez-site://sites/1/settings",
    "codez-site://sites/1/deployments/2/logs?offset=-1",
    "codez-site://sites?limit=1e3",
    "codez-site://sites?cursor=a&cursor=b",
    "codez-site://sites/1/deployments/2?offset=1",
    "codez-site://user@sites",
    "codez-site://sites/..%2Fusage",
    "codez-site://sites/1/analytics?range=1y",
    "codez-site://sites/1/analytics?offset=1",
    "codez-site://sites/1/analytics/pages",
    "codez-site://sites/analytics",
    "codez-site://sites/analytics/pv24h?siteIds=1,abc",
    `codez-site://sites/analytics/pv24h?siteIds=${Array(21).fill("1").join(",")}`,
    "codez-site://sites/analytics/pv24h?range=24h",
    "not a uri",
  ])("rejects %s", (uri) => {
    expect(resourcePath(uri)).toBeUndefined();
  });
});
