import fs from 'node:fs';

const path = 'tools/apply-home-search-solid-v1.mjs';
let source = fs.readFileSync(path, 'utf8');
const replacements = [
  [".ilike('phone', `%${suffix}%`)", ".ilike('phone', '%' + suffix + '%')"],
  [".ilike('full_name', `%${raw}%`)", ".ilike('full_name', '%' + raw + '%')"],
  [".ilike('client_phone', `%${suffix}%`)", ".ilike('client_phone', '%' + suffix + '%')"],
  [".ilike('client_name', `%${raw}%`)", ".ilike('client_name', '%' + raw + '%')"],
  ["_homeSearchSource: `db-click-resolve:${table}`", "_homeSearchSource: 'db-click-resolve:' + table"],
];
let changed = false;
for (const [from, to] of replacements) {
  if (source.includes(from)) {
    source = source.split(from).join(to);
    changed = true;
  }
}
if (changed) fs.writeFileSync(path, source, 'utf8');
console.log(`[fix-home-search-solid-installer-v1] ${changed ? 'fixed' : 'already fixed'}`);

// Keep the Arka permission repair in the existing prebuild chain.
await import('./apply-arka-master-access-v1.mjs');
await import('./verify-arka-master-access-v1.mjs');
