import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = process.cwd();
const parts = fs.readdirSync(root)
  .filter(name => /^lab-source\.part-\d+\.b64$/.test(name))
  .sort();

if (!parts.length) throw new Error('Scanner lab source archive is missing.');

const encoded = parts
  .map(name => fs.readFileSync(path.join(root, name), 'utf8').trim())
  .join('');
const files = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'));

for (const [relative, content] of Object.entries(files)) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

console.log(`Materialized ${Object.keys(files).length} isolated scanner-lab files from ${parts.length} archive parts.`);
