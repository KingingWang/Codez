# Runtime Environment Sanitization

Codez runtime processes must not let ambient shell variables silently change app, agent, CLI, or tool behavior. The runtime boundary treats the parent shell as untrusted defaults and re-injects only explicit Codez-owned configuration.

## Environment Roles

| Variable                          | Role                                                                     | Inheritance                                                            |
| --------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `CODEZ_ENV`                       | Product environment for API/OAuth endpoints (`test` / `production`)      | Explicitly injected by app/build/runtime config                        |
| `CODEZ_RUNTIME_ENV`               | Runtime shape for Codez behavior (`development` / `production` / `test`) | Explicitly injected by app/CLI runtime setup                           |
| `CODEZ_HTTP_PROXY`                | Explicit Codez proxy override                                            | Preserved and used by app/provider/network adapters                    |
| `CODEZ_NO_PROXY`                  | Explicit Codez proxy bypass rules                                        | Preserved and used by app/provider/network adapters                    |
| `CODEZ_AGENT_CA_CERT`             | Explicit Codez CA file for agent/model egress                            | Preserved and used by app/provider/network adapters                    |
| `CODEZ_TOOL_ENV_PASSTHROUGH_JSON` | Internal envelope for captured user proxy/CA env                         | Preserved across app/agent/CLI, expanded only when spawning user tools |
| `NODE_ENV`                        | Node ecosystem/build convention                                          | Not used for Codez runtime decisions and not inherited by default      |

## Sanitized Ambient Variables

The following variables are removed from inherited runtime environments before host, agent, CLI app, MCP stdio server, Bash/tool subprocesses, or provider adapters use them:

- `NODE_ENV`
- `ELECTRON_RUN_AS_NODE`
- `NODE_NO_WARNINGS`
- `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and lowercase variants
- `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`
- `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`
- npm/yarn/pnpm proxy and CA variables such as `npm_config_proxy`, `npm_config_https_proxy`, `npm_config_cafile`

Before removal, network-related user variables are captured into the Codez-owned `CODEZ_TOOL_ENV_PASSTHROUGH_JSON` envelope. The app, provider HTTP layer, and runtime mode checks never read that envelope. It is expanded back to the original standard variable names at user tool boundaries such as Bash, background terminal commands, and stdio MCP server processes.

`WebFetch` is the exception among in-process agent tools: it may read the captured proxy/no-proxy values from `CODEZ_TOOL_ENV_PASSTHROUGH_JSON` when no explicit `network.httpProxy`, `CODEZ_HTTP_PROXY`, `network.noProxy`, or `CODEZ_NO_PROXY` value is configured. This keeps WebFetch aligned with the user's browser/system egress path while preserving the sanitized default for model/provider requests. The WebFetch handler uses a direct fetch path and does not add a separate transient network retry loop; final errors must still preserve the deepest network code when available, for example `aborted (ECONNRESET)`.

## Explicit Re-Injection

Desktop app settings remain authoritative for app-managed proxy behavior. When `AppSettings.httpProxy` is configured, services inject `CODEZ_HTTP_PROXY` and the standard proxy variables only into the agent process. When `AppSettings.httpProxyNoProxy` is configured, services inject `CODEZ_NO_PROXY` and the standard no-proxy variables only from that explicit setting. If the app CA exists, services also inject `CODEZ_AGENT_CA_CERT` and `NODE_EXTRA_CA_CERTS` so Node can trust the CA during process startup.

Inside the CLI/agent runtime, standard inherited proxy/CA variables are sanitized again. The provider and HTTP adapter layers read only explicit Codez network keys or config (`network.httpProxy`, `CODEZ_HTTP_PROXY`, `network.noProxy`, `CODEZ_NO_PROXY`, `network.caCertFile`, `CODEZ_AGENT_CA_CERT`).

Tool subprocess environments are built in a narrower boundary. They start from the sanitized runtime env, expand `CODEZ_TOOL_ENV_PASSTHROUGH_JSON` back to the user's original proxy/CA variable names, then let explicit Codez network config override the same proxy/CA targets when present.

Command-level environment overlays are applied last. A user command can still intentionally set or delete `NODE_ENV`, proxy, or CA variables for that command only. Ambient runtime variables such as `NODE_ENV` still do not leak in by default; only the captured network passthrough set is restored for inherited tool subprocesses.

## Runtime Mode Rules

Codez-owned runtime decisions must use `CODEZ_RUNTIME_ENV`.

- `development`: local app/CLI debug behavior, debug logging, model-IO debug directory.
- `production`: packaged app and normal CLI behavior.
- `test`: test harness behavior; model-IO recording is disabled.

`NODE_ENV` is intentionally ignored for Codez runtime decisions. It may still be used by build tools or third-party packages outside Codez's runtime boundary.

## Protocol Server Dotenv Boundary

`app-server` and `agent-server` are protocol runtimes owned by their current Environment. In packaged `production` and test-harness `test` runtime modes they must not scan the current workspace or parent directories for `.env` files. Their configuration should come from the sanitized process environment, explicit app/service settings, and that Environment's Config/Credential Sources. Provider Registry objects and credentials are not supplied by another Environment over the protocol.

Only `CODEZ_RUNTIME_ENV=development` may load the nearest upward `.env` before starting the protocol server. This keeps local source debugging convenient while preventing packaged desktop sessions from inheriting project or user-home `.env` files.

Reason: protocol startup happens before any session request can return a structured Codez error. If a workspace or home `.env` is unreadable, malformed, or injects unexpected runtime variables in packaged mode, the helper process can exit before the stdio protocol is established. The renderer then only sees the secondary failure `Codez agent transport closed`, which hides the real bootstrap error and makes workspace behavior non-deterministic.
