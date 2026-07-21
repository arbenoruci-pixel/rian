import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = process.cwd();
const encoded = fs.readFileSync(path.join(root, 'scanner-v040.payload.b64'), 'utf8').trim();
const files = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'));
for (const [relative, content] of Object.entries(files)) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive:true });
  fs.writeFileSync(target, content);
}
await import(`./v040-impl.mjs?build=${Date.now()}`);
