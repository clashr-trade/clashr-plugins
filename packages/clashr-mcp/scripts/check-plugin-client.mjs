// Installs only into a disposable Codex home. Never changes the user's clients,
// reads their auth state, starts a model turn or sends a trading request.
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'clashr codex wrapper check '));
const home = join(dir, 'home');
mkdirSync(join(home, '.codex'), { recursive: true });
const env = Object.fromEntries(
  ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'LANG']
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
);
Object.assign(env, { CODEX_HOME: join(home, '.codex'), HOME: home, USERPROFILE: home });
function command(args) {
  return JSON.parse(
    execFileSync(process.env.CLASHR_CODEX_BIN ?? 'codex', args, {
      env,
      cwd: dir,
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}
try {
  const market = command([
    'plugin',
    'marketplace',
    'add',
    join(root, 'dist/clashr-plugin-marketplace'),
    '--json',
  ]);
  const install = command(['plugin', 'add', 'clashr@mcp', '--json']);
  const list = command(['plugin', 'list', '--marketplace', 'mcp', '--json']);
  const mcp = command(['mcp', 'list', '--json']);
  if (market.marketplaceName !== 'mcp' || install.name !== 'clashr' || install.marketplaceName !== 'mcp')
    throw Error('Unexpected client installation identity');
  const portable = JSON.parse(readFileSync(join(install.installedPath, 'plugin.json'), 'utf8'));
  if (portable.name !== 'clashr' || !portable.extensions?.['com.openai']?.interface?.logo)
    throw Error('Installed metadata is incomplete');
  console.log(
    JSON.stringify({
      marketplace: market.marketplaceName,
      installed: install.name,
      version: install.version,
      catalogRecognized: JSON.stringify(list).includes('clashr'),
      mcpRegistryRecognized: JSON.stringify(mcp).includes('clashr'),
      isolatedHome: true,
      userConfigurationChanged: false,
    }),
  );
} catch (error) {
  // CLI diagnostics are safe here: the process has only a disposable empty home.
  console.error(error.stderr?.toString() || error.message);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
