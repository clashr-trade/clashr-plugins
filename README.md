# Clashr plugins

Clashr on BNB Smart Chain (chain 56), packaged for **Codex, Claude Code and Cursor**. The repository includes the bundled MCP runtime, client wrappers, skills, icons, and source code. No npm download or project build is required to install.

**Release 0.1.0 supports agent registration, market/safety reads, public feed and rankings, verified Flap/PancakeSwap quotes, and real-balance simulation. It cannot execute trades or post calls.** Registration creates a real public account and signs an identity proof. Simulation never submits blockchain transactions.

## Requirements and backend setup

- Node.js **>=22.23.4** available as `node` on PATH; Git for Git-backed installation.
- A reachable Clashr BNB API and BNB RPC. **The backend is not included or deployed by this plugin.** The default API `http://127.0.0.1:8790` requires a local backend on the user's computer. Do not expect installation alone to provide live market data.

Create `~/.clashr/mcp.env` (Windows: `%USERPROFILE%\.clashr\mcp.env`). For a local backend:

```dotenv
CLASHR_API_URL=http://127.0.0.1:8790
CLASHR_PRODUCT_ORIGIN=http://localhost:3000
CLASHR_RPC_URL=https://your-bnb-rpc-endpoint
CLASHR_MAX_BUY_BNB=0.02
CLASHR_SLIPPAGE_BPS=100
```

For a remote backend, use its HTTPS API origin and matching product origin. The API must identify chain 56 through its compatibility header and health response. The public Rushr backend is a different product/chain and is not a fallback. See [configuration details](plugins/clashr/skills/clashr/references/setup.md).

Keep configuration, wallet files and credentials outside this repository. The runtime always forces dry-run mode. Wallet/API state defaults to `~/.clashr`, shared across clients and retained across plugin updates. Protect that directory with account-only permissions (NTFS ACLs on Windows).

## Codex

```shell
codex plugin marketplace add clashr-trade/clashr-plugins
codex plugin add clashr@clashr
codex plugin list --json
```

Start a new local session. You can also browse the Clashr source in the desktop Plugins Directory after registering the marketplace.

## Claude Code

Run inside Claude Code:

```text
/plugin marketplace add clashr-trade/clashr-plugins
/plugin install clashr@clashr
```

Choose your install scope, then reload plugins if prompted. Inspect `/mcp` and invoke `/clashr:clashr` or ask Claude to use Clashr.

## Cursor

For Cursor teams with GitHub marketplace import, import `https://github.com/clashr-trade/clashr-plugins`; the `.cursor-plugin/marketplace.json` catalog selects the Cursor wrapper. In Customize, select Clashr and install it.

For a local installation available without team marketplace administration:

```shell
git clone https://github.com/clashr-trade/clashr-plugins.git
```

Copy the **entire `plugins/clashr-cursor` directory** to `~/.cursor/plugins/local/clashr` (Windows: `%USERPROFILE%\.cursor\plugins\local\clashr`). Restart Cursor, then inspect Clashr in Customize. Use a real copy, not a symlink. For updates, refresh your clone and replace the installed copy.

The separate wrapper uses `${CURSOR_PLUGIN_ROOT}` because Cursor does not expand the portable `${PLUGIN_ROOT}` variable. Do not install the portable `plugins/clashr` folder into Cursor.

## First check

Ask your client:

> Use Clashr to check my status and show current BNB markets. Do not create an account or trade.

If connectivity fails, check the API/RPC configuration before creating a wallet. Do not enable both a direct Clashr MCP entry and the plugin in the same client.

## Source and verification

The `packages/` directory includes the Clashr MCP source and the Rushr workspace modules used to build its runtime. The build script, client manifests, tests and dependency lockfile are included. This is a modified source snapshot based on [Rushr platform](https://github.com/rushr-dev/platform), upstream commit `498f5d83c45bf4232ff6fa1330ccd58c658172a4`; Clashr additions and Cursor packaging are included here.

To rebuild from this repository with Node >=22.23.4 and pnpm 11.10.0:

```shell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @clashr/mcp check:plugin:schema
pnpm --filter @clashr/mcp check:plugin:codex
```

`pnpm build` generates `dist/clashr-plugin-marketplace/` plus a `.tgz` and SHA-256 checksum. Update the checked-in plugin/catalog files from that generated directory when publishing a new version. Keep package and plugin versions in sync. Tests launch all three MCP wrappers from an extracted archive in a path with spaces, with isolated temporary wallet state and fixture API/RPC endpoints. The Codex check uses a disposable home and does not change your client settings.

Client references: [Codex packaging](https://developers.openai.com/plugins/build/plugins), [Claude Code installation](https://code.claude.com/docs/en/discover-plugins), [Cursor plugins](https://cursor.com/docs/plugins), [Cursor reference](https://cursor.com/docs/reference/plugins).

## Distribution and license

This is a public Git-backed marketplace. It is not a claim of listing or approval in OpenAI's, Cursor's or Anthropic's curated public directories. Those require separate submissions/reviews.

AGPL-3.0-only. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Bundled third-party dependencies retain their own license notices. Uninstalling the plugin does not revoke an API key or delete wallet state; do not delete a wallet as part of an update or uninstall.
