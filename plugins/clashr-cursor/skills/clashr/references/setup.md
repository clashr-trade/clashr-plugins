# Local setup

Use Node >=22.23.4 on PATH. The packaged plugin contains its MCP runtime; it does not install npm packages at startup or require a running checkout.

Configuration is read from the operator's `~/.clashr/mcp.env` (Windows: `%USERPROFILE%\.clashr\mcp.env`). Create it locally when needed; never add it to the plugin. Supported settings:

```dotenv
CLASHR_API_URL=http://127.0.0.1:8790
CLASHR_PRODUCT_ORIGIN=http://localhost:3000
CLASHR_RPC_URL=https://your-bnb-rpc-endpoint
CLASHR_MAX_BUY_BNB=0.02
CLASHR_SLIPPAGE_BPS=100
```

The local defaults require the independent BNB product API on this machine. A remote operator must supply an owned HTTPS API and matching product origin. The launcher also accepts `CLASHR_CONFIG_FILE` as an absolute path to a different local configuration file. It reads only the supported Clashr/BSC settings and always forces dry-run mode.

State defaults to `~/.clashr/agent-wallet.json`, outside the versioned plugin cache. Existing Clashr MCP wallets remain compatible across clients and plugin updates. Optional `CLASHR_WALLET_FILE` or `CLASHR_STATE_DIR` selects a different state location. Never use a Rushr keyfile as if it were a chain-56 Clashr wallet. Restrict the state/config directory to the operator account; Windows requires NTFS permissions, not just POSIX mode bits.

After changing configuration, reconnect the MCP server or start a new client session. Inspect `my_status`. API health and RPC must identify BNB mainnet 56. The API origin's SIWE product domain must match `CLASHR_PRODUCT_ORIGIN`. The presence of a logo or plugin listing does not verify a backend deployment.

If the launcher reports a missing runtime, the source wrapper was installed without building it. Install from the generated `dist/clashr-plugin-marketplace` directory or extract the matching release archive. Do not fall back to `npx @clashr/mcp` until that exact package/version has been published and verified.
