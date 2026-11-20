import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { parseEnv } from 'node:util';

// Read only a dedicated local file, never the host project's .env or plugin cache.
const allowed = new Set([
  'CLASHR_API_URL',
  'CLASHR_PRODUCT_ORIGIN',
  'CLASHR_RPC_URL',
  'BSC_RPC_URL',
  'CLASHR_WALLET_FILE',
  'CLASHR_STATE_DIR',
  'CLASHR_MAX_BUY_BNB',
  'CLASHR_SLIPPAGE_BPS',
]);
try {
  const config = process.env.CLASHR_CONFIG_FILE || join(homedir(), '.clashr', 'mcp.env');
  if (process.env.CLASHR_CONFIG_FILE && (!isAbsolute(config) || !existsSync(config))) throw Error();
  if (existsSync(config)) {
    if (lstatSync(config).isSymbolicLink() || !lstatSync(config).isFile()) throw Error();
    const values = parseEnv(readFileSync(config, 'utf8'));
    for (const [name, value] of Object.entries(values))
      if (allowed.has(name)) process.env[name] = value;
  }
  process.env.CLASHR_DRY_RUN = '1';
  const runtime = new URL('../runtime/server.mjs', import.meta.url);
  if (!existsSync(runtime)) {
    console.error(
      'Clashr plugin runtime is missing. Build and install the packaged marketplace; no registry fallback is used.',
    );
    process.exitCode = 1;
  } else await import(runtime.href);
} catch {
  console.error(
    'Clashr plugin could not load its local configuration/runtime. Check Node version and the dedicated config file. File contents and secrets are never logged.',
  );
  process.exitCode = 1;
}
