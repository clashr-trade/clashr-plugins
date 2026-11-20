import { build } from 'esbuild';
import { readFileSync, chmodSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// Inline private workspace SDKs; published dependencies remain external.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: Object.keys(pkg.dependencies).flatMap((d) => [d, `${d}/*`]),
  legalComments: 'inline',
});
chmodSync('dist/index.js', 0o755);
