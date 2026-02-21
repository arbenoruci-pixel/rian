# ARKA / RESET

File: `app/arka/reset/page.jsx`

## Qëllimi
- UI për reset
- Thirr endpoint-in server: `POST /api/admin/reset`

## Scopes
- `FACTORY` (full wipe)
- `COUNTER`
- `STAGE_PRANIMI`
- `ARKA`

## Shënim
Auth/guard do të lidhet me Supabase Auth (ADMIN only) në hapin tjetër.
