# Broader desktop interaction plan

Bounded native desktop and real-component interaction checks have now executed;
see `qa/README.md` for the executable runners and evidence. The full matrix below
is still a plan, not a claim that all account/resource/remote cases passed.

Run against the leader-integrated desktop using an isolated temporary CODEX_HOME,
test-only account fixtures and a local test marketplace. Never reuse developer
credentials or install a real external plugin for these tests.

1. Fresh home / missing binary: application shell opens without a Z.ai gate; open
   a workspace and Settings → Codex. Missing runtime yields an actionable error.
   Files, terminal and Git remain reachable. Continue in Welcome always works.
2. Mock existing API-key / ChatGPT / Bedrock account and no-auth provider. Check
   native account display; never imply a null account is signed in. Start browser
   and device-code login; URL is opened through the platform service. Verify pending
   state, cancel with exact loginId, retry after failure and refresh after login.
   Logout requires confirmation; API-key input clears and never enters storage/logs.
3. Supply two model pages. Select a model with fewer reasoning options; impossible
   efforts cannot be saved. Verify native model name (not catalog id), atomic batch
   writes and that existing threads are not falsely described as updated.
4. Managed permissions restrict approval/sandbox choices. No writable user-layer
   version disables mutations. Conflict response leaves form draft and visible error;
   explicit refresh obtains current version. okOverridden shows warning; effective
   values remain authoritative. Single-value/batch malformed JSON sends no request.
5. Skills include disabled entries and scan errors. Toggle one by native path;
   rejected mutation does not optimistically change state. Check reload response.
6. MCP catalog spans pages and includes failed discovery. Show connection/auth/tools
   separately. OAuth opens returned URL; no successful auth claim before refresh.
   Reload invokes config/mcpServer/reload, with no legacy MCP config writes.
7. Plugins have local and remote marketplaces, load errors, installed/disabled and
   policy-restricted entries. Install uses native selectors; consent-required install
   remains blocked. Uninstall/removal confirmation works. Add/update/remove uses
   native source/marketplaceName; a failed mutation never changes displayed inventory.
8. Open old provider/skills/MCP/plugin deep links on desktop: they show Codex.
   Legacy workflow/CUA/migration sections show capability limits, not editable legacy
   controls. Web retains its prior sections and no desktop-only Codex entry.
9. Same path, two remote identities: switch while a read/login/write is delayed.
   Old response/URL/draft never appears in the new target. Disconnect never sends
   a remote request to the local Host. Reconnect reads authority, no mutation retry.
10. Test 360px/desktop widths, keyboard-only focus, English/Chinese, light/dark,
    long paths/labels, empty lists, malformed response, repeated clicks and refresh
    during operations. No duplicated writes or uncaught rejection.

Record runner command, native build/schema revision, screenshots, RPC assertions,
and cleanup evidence when these cases are actually executed. This plan is not an
E2E pass or evidence of workflow/CUA parity.
