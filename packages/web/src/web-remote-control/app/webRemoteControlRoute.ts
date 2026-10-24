import {
  matchesWebRemoteControlRoutePath,
  resolveWebRemoteControlRoutePathFromBaseUrl,
} from "@codez/shared";

interface WebRemoteControlRouteEnv {
  readonly VITE_WEB_REMOTE_CONTROL_ROUTE_PATH?: string;
  readonly BASE_URL: string;
}

/**
 * 页面路由与资源目录分离：OSS 多版本发布用 `/remote/v4/<version>/` 作为 Vite base，
 * 让每个子资源请求自带版本，但页面入口仍是 `/remote/v4`。构建时注入路由变量即可覆盖；
 * 未注入（Docker、v3、开发 `/remote`）时沿用 BASE_URL 推导，行为与历史一致。
 * 浏览器扩展以 `./` 构建并从 `/index.html` 加载时，返回 `/index.html`。
 */
export function resolveWebRemoteControlRoutePath(env: WebRemoteControlRouteEnv): string {
  const explicitRoutePath = env.VITE_WEB_REMOTE_CONTROL_ROUTE_PATH?.trim();
  if (explicitRoutePath) {
    return resolveWebRemoteControlRoutePathFromBaseUrl(explicitRoutePath);
  }
  if (env.BASE_URL.trim() === "./") {
    return "/index.html";
  }
  return resolveWebRemoteControlRoutePathFromBaseUrl(env.BASE_URL);
}

/** GitHub Pages 的项目名前缀也属于 v4 页面路由，v3/开发入口不参与桌面版本校验。 */
export function isVersionedWebRemoteControlRoute(pathname: string, routePath: string): boolean {
  return (
    /\/remote\/v4\/?$/u.test(routePath) && matchesWebRemoteControlRoutePath(pathname, routePath)
  );
}
