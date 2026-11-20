// Author-time verification against the published portable schemas. Not used at
// runtime: installing/starting Clashr never downloads schemas or dependencies.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const fromSdk = createRequire(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'));
const Ajv2020 = fromSdk('ajv/dist/2020.js').default;
const Ajv = fromSdk('ajv').default;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const plugin = join(root, 'dist/clashr-plugin-marketplace/plugins/clashr');
const checks = [];
for (const name of ['plugin', 'mcp']) {
  const url = `https://agent-plugins.org/schemas/1.0.0/${name}.schema.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error(`Could not fetch official ${name} schema`);
  const schema = await response.json(),
    ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema),
    document = JSON.parse(readFileSync(join(plugin, `${name}.json`), 'utf8'));
  if (!validate(document)) throw Error(JSON.stringify(validate.errors));
  checks.push(`${name}.json`);
}
for (const [name, path] of [
  ['plugin', 'plugins/clashr-cursor/.cursor-plugin/plugin.json'],
  ['marketplace', '.cursor-plugin/marketplace.json'],
]) {
  const response = await fetch(`https://raw.githubusercontent.com/cursor/plugins/main/schemas/${name}.schema.json`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error(`Could not fetch official Cursor ${name} schema`);
  const validate = new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(await response.json());
  if (!validate(JSON.parse(readFileSync(join(root, 'dist/clashr-plugin-marketplace', path), 'utf8'))))
    throw Error(JSON.stringify(validate.errors));
  checks.push(path);
}
console.log(JSON.stringify({ officialPortableSchemas: '1.0.0', officialCursorSchemas: true, validated: checks }));
