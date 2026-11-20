import { build } from 'esbuild';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join, relative, sep, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (lstatSync(path).isSymbolicLink()) throw Error('Plugin source cannot contain symlinks');
    return entry.isDirectory() ? files(path) : [path];
  });
}
function within(parent, path) {
  const rel = relative(parent, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

export async function buildPlugin() {
  const pkg = readJson(join(root, 'packages/clashr-mcp/package.json'));
  const source = join(root, 'plugins/clashr'),
    manifest = readJson(join(source, 'plugin.json'));
  if (
    pkg.version !== manifest.version ||
    readJson(join(source, '.claude-plugin/plugin.json')).version !== pkg.version
  )
    throw Error('Clashr plugin and MCP versions must match');
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  if (realpathSync(dist) !== dist)
    throw Error('Build output must not escape the workspace via a symlink');
  const stage = mkdtempSync(join(dist, '.clashr-plugin-'));
  const destination = join(dist, 'clashr-plugin-marketplace');
  try {
    const plugin = join(stage, 'plugins/clashr');
    mkdirSync(plugin, { recursive: true });
    for (const path of [
      'plugin.json',
      'mcp.json',
      '.mcp.json',
      '.claude-plugin/plugin.json',
      'skills/clashr/SKILL.md',
      'skills/clashr/references/setup.md',
      'scripts/start.mjs',
      'assets/icon.png',
      'assets/logo.png',
      'README.md',
    ]) {
      const from = join(source, path);
      if (
        !lstatSync(from).isFile() ||
        lstatSync(from).isSymbolicLink() ||
        !within(source, realpathSync(from))
      )
        throw Error('Plugin source must be a contained regular file');
      mkdirSync(join(plugin, path, '..'), { recursive: true });
      cpSync(from, join(plugin, path));
    }
    cpSync(join(root, 'packages/clashr-mcp/LICENSE'), join(plugin, 'LICENSE'));
    cpSync(join(root, 'packages/clashr-mcp/NOTICE'), join(plugin, 'NOTICE'));
    const runtime = join(plugin, 'runtime/server.mjs');
    // The plugin cache is relocatable: no npm installation, workspace imports,
    // inherited node_modules, shell command construction or registry fallback.
    const bundled = await build({
      absWorkingDir: root,
      entryPoints: ['packages/clashr-mcp/src/index.ts'],
      outfile: runtime,
      bundle: true,
      packages: 'bundle',
      platform: 'node',
      target: 'node22',
      format: 'esm',
      banner: {
        js: "import {createRequire as clashrCreateRequire} from 'node:module'; const require=clashrCreateRequire(import.meta.url);",
      },
      legalComments: 'inline',
      metafile: true,
    });
    // Preserve full dependency license texts alongside the executable bundle.
    const dependencies = new Map();
    for (const input of Object.keys(bundled.metafile.inputs)) {
      if (!input.split(/[\\/]/).includes('node_modules')) continue;
      let dir = dirname(resolve(root, input));
      while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
      if (!existsSync(join(dir, 'package.json'))) continue;
      const dependency = readJson(join(dir, 'package.json'));
      const key = `${dependency.name}@${dependency.version}`;
      if (dependencies.has(key)) continue;
      const notices = readdirSync(dir).filter((name) => /^(license|licence|copying|notice)([.-]|$)/i.test(name))
        .filter((name) => lstatSync(join(dir, name)).isFile())
        .map((name) => `${name}\n${readFileSync(join(dir, name), 'utf8')}`);
      dependencies.set(key, `${key}\nDeclared license: ${dependency.license ?? 'See upstream package'}\n${notices.join('\n\n')}`);
    }
    writeFileSync(join(plugin, 'THIRD_PARTY_NOTICES.txt'), [...dependencies.entries()]
      .sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value).join('\n\n' + '='.repeat(72) + '\n\n') + '\n');
    mkdirSync(join(stage, '.agents/plugins'), { recursive: true });
    mkdirSync(join(stage, '.claude-plugin'), { recursive: true });
    const entry = { name: 'clashr', description: manifest.description, version: pkg.version };
    writeFileSync(
      join(stage, '.claude-plugin/marketplace.json'),
      JSON.stringify(
        {
          name: 'mcp',
          owner: manifest.author,
          plugins: [{ ...entry, source: './plugins/clashr', category: 'finance' }],
        },
        null,
        2,
      ) + '\n',
    );
    writeFileSync(
      join(stage, '.agents/plugins/marketplace.json'),
      JSON.stringify(
        {
          name: 'mcp',
          interface: { displayName: 'Clashr MCP' },
          plugins: [
            {
              name: 'clashr',
              source: { source: 'local', path: './plugins/clashr' },
              policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
              category: 'Finance',
            },
          ],
        },
        null,
        2,
      ) + '\n',
    );
    // Cursor does not expand the portable ${PLUGIN_ROOT}. Keep its wrapper
    // separate so each client sees one unambiguous manifest and launch command.
    const cursor = join(stage, 'plugins/clashr-cursor');
    mkdirSync(cursor, { recursive: true });
    for (const path of ['skills', 'scripts', 'assets', 'runtime', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'README.md'])
      cpSync(join(plugin, path), join(cursor, path), { recursive: true });
    mkdirSync(join(cursor, '.cursor-plugin'), { recursive: true });
    writeFileSync(join(cursor, '.cursor-plugin/plugin.json'), JSON.stringify({
      name: 'clashr', displayName: 'Clashr', version: pkg.version,
      description: manifest.description, author: { name: manifest.author.name },
      homepage: manifest.homepage, repository: 'https://github.com/clashr-trade/clashr-plugins',
      license: manifest.license, logo: './assets/logo.png', skills: './skills/',
      mcpServers: './mcp.json',
    }, null, 2) + '\n');
    const cursorMcp = readJson(join(plugin, 'mcp.json'));
    cursorMcp.mcpServers.clashr.args = ['${CURSOR_PLUGIN_ROOT}/scripts/start.mjs'];
    writeFileSync(join(cursor, 'mcp.json'), JSON.stringify(cursorMcp, null, 2) + '\n');
    mkdirSync(join(stage, '.cursor-plugin'), { recursive: true });
    writeFileSync(join(stage, '.cursor-plugin/marketplace.json'), JSON.stringify({
      name: 'mcp', owner: { name: 'Clashr' },
      metadata: { description: 'Clashr on BNB Chain: registration, markets, quotes and simulation.' },
      plugins: [{ name: 'clashr', source: './plugins/clashr-cursor', description: manifest.description }],
    }, null, 2) + '\n');
    const hashes = Object.fromEntries(
      files(plugin).map((path) => [
        relative(plugin, path).split(sep).join('/'),
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ]),
    );
    writeFileSync(
      join(stage, 'build-info.json'),
      JSON.stringify(
        { plugin: manifest.name, version: pkg.version, mcpPackage: pkg.name, files: hashes,
          cursorFiles: Object.fromEntries(files(cursor).map((path) => [
            relative(cursor, path).split(sep).join('/'),
            createHash('sha256').update(readFileSync(path)).digest('hex'),
          ])) },
        null,
        2,
      ) + '\n',
    );
    // Only replace this builder's fixed output after checking its resolved target.
    if (existsSync(destination)) {
      if (!within(dist, realpathSync(destination)))
        throw Error('Refusing to replace a build directory outside dist');
      rmSync(destination, { recursive: true, force: true });
    }
    renameSync(stage, destination);
    const archive = join(dist, `clashr-plugin-marketplace-${pkg.version}.tgz`);
    execFileSync('tar', ['-czf', archive, '-C', destination, '.'], { stdio: 'pipe' });
    const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
    writeFileSync(`${archive}.sha256`, `${sha256}  clashr-plugin-marketplace-${pkg.version}.tgz\n`);
    return { marketplace: destination, archive, sha256 };
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPlugin()
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        'Clashr plugin packaging failed. Check source assets, matching versions, and Node/tar availability.',
      );
      process.exitCode = 1;
    });
}
