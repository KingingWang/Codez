import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {
  resolveBigModelApiOrigin,
  resolveRuntimeCodezEndpointOrigin,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
} from "../shared/src/codezEndpoint.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const { version } = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const codezEnv = env.CODEZ_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
  const endpointEnv = { ...env, CODEZ_ENV: codezEnv };
  const endpointOrigin = resolveRuntimeCodezEndpointOrigin(endpointEnv);
  const oauthOrigin = resolveZaiOAuthOrigin(endpointEnv);
  const oauthClientId = resolveZaiOAuthClientId(endpointEnv);
  // BigModel 授权入口必须跟随 CODEZ_ENV，否则测试环境会把测试账号带到生产授权页。
  const bigmodelOAuthOrigin = resolveBigModelApiOrigin(endpointEnv);

  return {
    root: resolve(HERE),
    base: "/cn/share/",
    // Share 复用 Web 的 material-icons 素材，但不复制完整 Web 源码/依赖。
    // 这样 dev:web-share 与 Docker 生产构建都从同一份 public 资源读取图标。
    publicDir: resolve(REPO_ROOT, "packages/web/public"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(REPO_ROOT, "packages/ui/src"),
        "@codez/shared": resolve(REPO_ROOT, "packages/shared/src/index.ts"),
        // Share 镜像不安装 @codez/ui（它会带入 services/rpc 闭包），子路径导入必须显式指向源码。
        "@codez/ui/useTheme": resolve(REPO_ROOT, "packages/ui/src/useTheme.ts"),
        "@codez/ui/conversation-share-readonly": resolve(
          REPO_ROOT,
          "packages/share-ui/src/index.ts",
        ),
        // 登录卡片要用 provider 图标（svg 走 @ -> packages/ui/src 别名解析）。
        // 该模块只依赖 shared/lucide/cn，不会把 services/rpc 闭包带进 share 镜像。
        "@codez/ui/oauth-provider-icon": resolve(
          REPO_ROOT,
          "packages/ui/src/lib/oauthProviderIcon.tsx",
        ),
      },
    },
    define: {
      __CODEZ_VERSION__: JSON.stringify(version),
      __CODEZ_COMMIT__: JSON.stringify(env.CODEZ_COMMIT || "unknown"),
      __CODEZ_ENV__: JSON.stringify(codezEnv),
      "import.meta.env.VITE_CODEZ_BASE_URL": JSON.stringify(endpointOrigin),
      "import.meta.env.VITE_CODEZ_ENDPOINT_ORIGIN": JSON.stringify(endpointOrigin),
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(oauthClientId),
      "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(oauthOrigin),
      "import.meta.env.VITE_BIGMODEL_OAUTH_ORIGIN": JSON.stringify(bigmodelOAuthOrigin),
    },
    build: {
      outDir: resolve(REPO_ROOT, "packages/web-share/dist"),
      emptyOutDir: true,
      sourcemap: mode === "production" ? "hidden" : true,
    },
  };
});
