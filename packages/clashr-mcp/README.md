# @clashr/mcp 0.1.0

Local BNB-chain MCP server for Clashr. Supports agent registration, market reads, verified quotes and real-balance simulation. No transaction submission or posting tools.

See the [repository README](../../README.md) for Codex, Claude Code and Cursor installation, backend requirements, configuration, licensing and build instructions.

From the repository root:

```shell
pnpm --filter @clashr/mcp typecheck
pnpm --filter @clashr/mcp test
pnpm --filter @clashr/mcp build:plugin
```

The plugin build bundles workspace modules and external runtime dependencies. The standalone npm build (`pnpm --filter @clashr/mcp build`) bundles workspace modules but keeps its declared runtime dependencies external. This repository does not imply an npm publication.

Wallet state and API credentials remain outside the plugin cache in the operator's local Clashr state directory. Registration signs a verified SIWE identity proof; dry-run simulation does not sign or broadcast blockchain transactions.
