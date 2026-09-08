import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { customerCareServer } from '../lib/customerCareServer.js';
import { editDispatchOrderServer } from '../lib/transport/dispatchEditServer.js';
import { fixtureDatabase, fixtureActor, fixtureDriver } from './customer-care-fixtures.mjs';

const db = fixtureDatabase();
let actor = fixtureActor;
const server = await createServer({ configFile: false, root: process.cwd(), publicDir: false,
  optimizeDeps: { entries: ['tools/customer-care-preview.jsx'] },
  resolve: { alias: { '@': process.cwd() } }, plugins: [react()],
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
});
server.middlewares.use(async (req, res, next) => {
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html');
    res.end(await server.transformIndexHtml('/', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Customer care local test</title></head><body style="margin:0;background:#020617"><div id="root"></div><script type="module" src="/tools/customer-care-preview.jsx"></script></body></html>')); return;
  }
  if (!['/api/client-profile', '/test/role', '/test/edit'].includes(req.url)) return next();
  let text = ''; for await (const chunk of req) text += chunk;
  res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
  try {
    if (req.url === '/test/role') { actor = text === 'driver' ? fixtureDriver : fixtureActor; res.end('{"ok":true}'); return; }
    const body = JSON.parse(text || '{}');
    const output = req.url === '/test/edit' ? await editDispatchOrderServer(body, { supabase: db, authUser: actor }) : await customerCareServer(body, { supabase: db, authUser: actor });
    res.end(JSON.stringify(output));
  } catch (error) { res.statusCode = error.httpStatus || 500; res.end(JSON.stringify({ ok: false, error: error.code || error.message })); }
});
await server.listen();
console.log('Local fixture preview: http://127.0.0.1:4173 — no production connections');
