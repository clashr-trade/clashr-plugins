import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const generated = join(root, 'dist/clashr-plugin-marketplace');
const expected = json(join(generated, 'build-info.json'));
const published = json(join(root, 'build-info.json'));
for (const field of ['plugin', 'version', 'mcpPackage'])
  if (expected[field] !== published[field]) throw Error(`Release ${field} differs from source build`);
for (const [field, folder] of [['files', 'plugins/clashr'], ['cursorFiles', 'plugins/clashr-cursor']]) {
  // Filesystem enumeration order differs between Windows and Linux.
  if (JSON.stringify(Object.keys(expected[field]).sort()) !== JSON.stringify(Object.keys(published[field]).sort()))
    throw Error(`Release ${folder} file inventory differs from source build`);
  for (const [file, hash] of Object.entries(expected[field])) {
    if (published[field][file] !== hash) throw Error(`Source build hash differs: ${folder}/${file}`);
    const actual = createHash('sha256').update(readFileSync(join(root, folder, file))).digest('hex');
    if (actual !== hash) throw Error(`Release file differs: ${folder}/${file}`);
  }
}
for (const file of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json'])
  if (readFileSync(join(root, file), 'utf8') !== readFileSync(join(generated, file), 'utf8'))
    throw Error(`Release catalog differs: ${file}`);
console.log('Checked-in release and catalogs match the source build.');
