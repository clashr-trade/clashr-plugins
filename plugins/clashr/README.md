# Clashr plugin for Codex, Claude Code and Cursor

This local, desktop/CLI plugin wraps `@clashr/mcp` 0.1.0. It offers BNB agent registration, market/safety reads, feed, human/agent rankings, quotes and real-balance simulation. It cannot execute trades or post calls. No npm package or public backend deployment is implied by installation.

## Build the installable marketplace

From the platform repository root (Node >=22.23.4, pnpm dependencies installed):

```powershell
pnpm --filter @clashr/mcp build:plugin
```

This produces `dist/clashr-plugin-marketplace/`, `dist/clashr-plugin-marketplace-0.1.0.tgz` and its SHA-256 file. The marketplace contains Codex, Claude Code and Cursor catalogs. `plugins/clashr` contains the portable/Claude wrapper; `plugins/clashr-cursor` contains the Cursor wrapper. Both include the same bundled MCP runtime, logos, license and skill. Runtime changes require rebuilding and refreshing/reinstalling the client plugin.

The builder uses an explicit source allowlist; it does not package `.env` files, wallets, API keys, node_modules or machine paths. The runtime contains no npm/registry installer. Existing Rushr source/catalogs are not renamed or modified. No lifecycle hooks run setup, install dependencies or create accounts.

## Configure your local backend

Create `%USERPROFILE%\.clashr\mcp.env` on Windows or `~/.clashr/mcp.env` on macOS/Linux. For the existing local API:

```dotenv
CLASHR_API_URL=http://127.0.0.1:8790
CLASHR_PRODUCT_ORIGIN=http://localhost:3000
CLASHR_RPC_URL=https://your-bnb-rpc-endpoint
CLASHR_MAX_BUY_BNB=0.02
CLASHR_SLIPPAGE_BPS=100
```

Replace the RPC placeholder locally; never add this file to the package. Alternatively set `CLASHR_CONFIG_FILE` to an absolute local env-file path. Only supported Clashr/BSC settings are read from that file. Dry-run mode is forced after loading it; `NODE_OPTIONS` and arbitrary environment settings are ignored. State remains in `~/.clashr`, outside the client cache, so plugin updates do not replace a wallet. Protect the directory with account-only permissions/Windows NTFS ACLs.

Remote users need their own configured API origin and matching product domain; localhost always refers to their own machine. Both the API and RPC must identify chain 56. The original public Rushr backend and chain-4663 wallets are not fallbacks.

## Install in Codex

Run from the repository root:

```powershell
codex plugin marketplace add ./dist/clashr-plugin-marketplace
codex plugin add clashr@clashr
codex plugin list --json
```

Start a new Codex session and ask: "Use Clashr to check my status and show current BNB markets. Do not create an account or trade."

## Install in Claude Code

Inside a Claude Code session opened at the repository root:

```text
/plugin marketplace add ./dist/clashr-plugin-marketplace
/plugin install clashr@clashr
```

Restart/reload plugins, inspect `/mcp`, then invoke `/clashr:clashr` or ask Claude to use Clashr. For a temporary development session, use `claude --plugin-dir ./dist/clashr-plugin-marketplace/plugins/clashr`.

## Install in Cursor

Use the repository's `.cursor-plugin/marketplace.json` when importing a GitHub marketplace. It points at `plugins/clashr-cursor`, whose MCP configuration uses `${CURSOR_PLUGIN_ROOT}`. For local installation, copy that entire folder to `~/.cursor/plugins/local/clashr` and restart Cursor. Do not symlink the folder. Open Customize and inspect the Clashr skill and MCP server. The portable `plugins/clashr` folder uses `${PLUGIN_ROOT}`, which Cursor does not expand.

Public Git distribution: https://github.com/clashr-trade/clashr-plugins. In Codex use `codex plugin marketplace add clashr-trade/clashr-plugins`, then `codex plugin add clashr@clashr`. In Claude Code use `/plugin marketplace add clashr-trade/clashr-plugins`, then `/plugin install clashr@clashr`. A public Git repository does not imply approval or listing in any vendor's public plugin directory.

Claude uses `.claude-plugin/plugin.json` and `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}`. Portable/Codex clients use root `plugin.json` and `mcp.json` with `${PLUGIN_ROOT}`. Each points to the same bundled launcher/runtime; arguments remain separate so spaces in cache paths are supported.

If you already configured Clashr directly as an MCP server, disable/remove that direct entry before using the plugin to avoid duplicate servers. Uninstalling a plugin does not revoke an agent API key or remove the external `~/.clashr` wallet. Do not delete wallet state as part of uninstall/rollback.

## Share the package

Give the generated `.tgz` and checksum to the intended tester. Verify its checksum, extract it into a fresh directory, then add that directory as a marketplace using the commands above. The archive contains the runtime; no copy of this checkout is needed. A git-hosted marketplace/release and npm/public-directory publication remain separate release steps.

## Validate changes

```powershell
pnpm --filter @clashr/mcp typecheck
pnpm --filter @clashr/mcp test
pnpm --filter @clashr/mcp check:plugin:schema
pnpm --filter @clashr/mcp check:plugin:codex
```

Tests rebuild the bundle and extract the archive into a new directory containing spaces. Both manifest launchers start with no project `node_modules`; a fixture API/RPC verifies status, config loading, forced dry-run and secret handling. The schema check fetches the official Agent Plugins schemas at author time only. The Codex check uses a disposable empty home and confirms install, catalog and MCP registry discovery without modifying your client settings. If Claude Code is installed, also run `claude plugin validate ./dist/clashr-plugin-marketplace` and test installation through `/plugin`.

For an actual read-only API/RPC smoke through the bundled wrapper, run from the repository root:

```powershell
node --env-file=apps/web/.env.local packages/clashr-mcp/scripts/smoke.mjs --plugin --pancake
```

This uses an isolated empty state/config, never the operator's wallet. A current launch may correctly refuse quoting due to its on-chain rules; pass a verified token address as an additional argument when needed. For recorded validation and limits see `docs/bsc-migration-status.md` in the source repository. User account creation, funded transactions, public publication and global client settings changes are not part of packaging verification.
