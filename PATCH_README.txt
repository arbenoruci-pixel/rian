PATCH: SPA ROUTING FIX FOR VERCEL

What this fixes:
- Direct-open and hard-reload 404s on app routes like /porosit, /pastrimi, /gati, /transport, etc.
- Vercel should serve index.html for client-side routes, while filesystem routes and API routes continue to resolve before rewrites.

Apply:
1) Replace vercel.json in the project root with the one in this patch.
2) Commit + push.
3) Redeploy.
