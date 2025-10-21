# MOZULUK • Next.js Tools (Vercel-ready)

This project serves two static tools and a secure server API that proxies Google results via SerpAPI — **your key stays on the server**.

## Files
- `/public/mozuluk_calc_leadfinder.html` — calculator + basic lead finder
- `/public/mozuluk_lead_finder_pro.html` — PRO lead finder (calls `/api/leads`)
- `/pages/api/leads.js` — server route that calls SerpAPI with `process.env.SERPAPI_KEY`
- `/pages/index.js` — simple launcher page

## Local dev
```bash
npm i
npm run dev
# open http://localhost:3000
```

## Deploy to Vercel
1. Push this folder to **GitHub** (e.g., repo `mozuluk-tools-next`).
2. In **Vercel → Add New Project → Import** your repo.
3. Framework: **Next.js** (auto-detected).
4. Environment Variable: set `SERPAPI_KEY` to your SerpAPI key in **Project Settings → Environment Variables**.
5. Deploy.  
Open:
- `/` — launcher
- `/mozuluk_calc_leadfinder.html`
- `/mozuluk_lead_finder_pro.html`

## Notes
- The PRO page fetches `/api/leads?q=...` so the key is never exposed to the browser.
- If you still want to open native Google tabs instead of the in-page list, switch provider to **Fallback — Open tabs** in the UI.