PWA OFFLINE BOOT PATCH (Next.js App Router)

What this fixes:
- iOS PWA "Cannot Open Page" when offline (before UI loads)
- Adds a Service Worker navigation fallback that ALWAYS returns cached HTML for mode:'navigate'

Files included:
- public/sw.js
- app/offline/page.jsx
- components/SwRegister.jsx (optional helper)

What YOU must do (1 minute):
1) Ensure the SW is registered on the client.
   If you already register a SW, skip this step.
   Otherwise, import and render <SwRegister /> once in your app (client side), e.g. in app/layout.(js|jsx|tsx):

   - Add:   import SwRegister from '@/components/SwRegister';
   - Then inside <body>:  <SwRegister />

   IMPORTANT: layout must remain a Server Component; SwRegister is a Client Component so it's safe to render inside body.

2) Deploy, open the PWA once online, then test:
   - Close PWA
   - Airplane mode ON
   - Open PWA
   Expected: it opens (shows cached page or /offline), NOT "cannot open page"

Notes:
- If middleware redirects unauth users, prefer client-side auth redirect for pages. Middleware should protect APIs, not the shell.
