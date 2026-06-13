ACTIVE RUNTIME MAP
==================

AKTIV NË RUNTIME
- Shell / startup: src/main.jsx -> src/AppRoot.jsx
- Routing truth: src/generated/routes.generated.jsx
- Session truth: lib/sessionStore.js
- Dev API truth: server/index.mjs (Vite proxy /api -> :8787)
- Deploy API truth: root api/**
- Service worker truth: public/sw.js

LEGACY / INACTIVE
- app/layout.jsx -> legacy Next shell reference only
- app/api/** -> legacy Next API layer, not active Vite runtime source of truth
- app/admin/devices/page.jsx -> alias wrapper only
- app/arka/cash/page.jsx -> alias wrapper only
- app/arka/corporate/page.jsx -> alias wrapper only
- app/arka/shpenzime/page.jsx -> alias wrapper only
- app/transport/arka/page.jsx -> alias wrapper only

PATCH RULE
- Për runtime/startup/routing ndrysho vetëm src/**, components/**, lib/**, public/sw.js, server/**, api/**
- Mos e përdor app/layout.jsx ose app/api/** si source of truth për patch-et e reja
