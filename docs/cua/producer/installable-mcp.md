# Installable MCP package

> DEPRECATED. The Python MCP server that lived in this repo is **removed**, so
> there is no longer a Python distribution to install. The canonical CUA MCP
> tool is now the TypeScript package **@codez/codez-cua** (npm). This document
> described the old `uvx --from codez-cua[macos]@<wheel> codez-cua` install
> profiles, the private-PyPI / file-share distribution flows, and the
> `scripts/package_mcp_distribution.py` release-bundle pipeline — all of which
> targeted the removed Python wheel and no longer apply.

Install the canonical tool from npm:

```bash
npm install @codez/codez-cua
# or, without installing:
npx @codez/codez-cua
```

The TypeScript CLI supports both transports. STDIO is still the default; local
Streamable HTTP is available explicitly:

```bash
npx @codez/codez-cua --transport streamable-http --host 127.0.0.1 --port 8001
```

The MCP endpoint is `http://127.0.0.1:8001/mcp`.

Source and the product/broker install profiles live in the z-code repo:
[git.example.invalid/codegeex/z-code](https://git.example.invalid/codegeex/z-code)
→ package [@codez/codez-cua](https://www.npmjs.com/package/@codez/codez-cua).

What this repo still hosts (the real-model act-verify harness, the canonical
skill, screenshot-pipeline parity fixtures) is described in the top-level
`README.md`. The earlier Python packaging/distribution guide is preserved in the
git history of this repo (see the commit prior to `refactor/deprecate-python`).

For background on the TypeScript rewrite and this deprecation, see the Feishu
design doc:
[BE9UdI4zMo4HjRx4659cTHOnn9f](https://internal-docs.example.invalid/redacted).
