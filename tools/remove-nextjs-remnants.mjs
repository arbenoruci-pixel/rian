#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || process.cwd());

const targets = [
  'app/api',
  'app/layout.jsx',
  'app/error.jsx',
  'app/loading.jsx',
  'app/admin/devices/page.jsx',
  'app/_redirect_to_arka.jsx',
  'app/arka/cash/page.jsx',
  'app/arka/corporate/page.jsx',
  'app/arka/shpenzime/page.jsx',
  'app/transport/arka/page.jsx',
  'src/shims/next-link.jsx',
  'src/shims/next-navigation.js',
  'src/shims/next-dynamic.jsx',
  'src/shims/next-script.jsx',
  'src/shims/next-server.d.ts',
];

async function removeTarget(rel) {
  const full = path.join(root, rel);
  try {
    await fs.rm(full, { recursive: true, force: true });
    console.log(`removed ${rel}`);
  } catch (error) {
    console.log(`skip ${rel}: ${error?.message || error}`);
  }
}

for (const target of targets) {
  await removeTarget(target);
}

console.log('Next.js dead-remnant cleanup finished. ALIGN-FASTBOOT-V6.');
