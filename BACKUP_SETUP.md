



# BACKUP (FLETORJA) — TEPIHA

Ky patch e shton një **backup automatik ditor** (çdo 24 orë) dhe një faqe **/fletore** ku mund t’i shohësh/printosh klientët & porositë si “fletore”, edhe nëse aplikacioni prishet ose localStorage bëhet lëmsh.

## 1) Çka u shtua
- **/fletore** — faqe në app që:
  - lexon backup-in e fundit
  - ta jep link për **DOWNLOAD JSON / CSV / HTML**
  - ka butonin **PRINT (PDF)**
  - ka butonin **RUN BACKUP NOW** (manual)
- **/api/backup/run** — krijon backup (JSON+CSV+HTML) dhe e ruan në Supabase Storage (bucket: `tepiha-photos` në folderin `backups/`)
- **/api/backup/latest** — e gjen backup-in e fundit
- **/api/backup/cron** — endpoint për Vercel Cron (automatik çdo ditë)
- **vercel.json** — cron job: `10 2 * * *` (UTC) = 03:10 (Prishtinë/Beograd)

## 2) Env variables (Vercel)
Shto këto në Vercel → Project → Settings → Environment Variables:

### Detyrimisht
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`  ✅ (kjo e lejon eksportin + ruajtjen në Storage)

### Për Cron (automatik)
- `CRON_SECRET` (vendos një string p.sh. `tepiha_backup_2380`)

### Opsionale — email
Nëse do me ta qu backup-in në email (link), shto:
- `BACKUP_EMAIL_TO` (p.sh. emaili yt)
- `RESEND_API_KEY` (Resend)

> Nëse s’i vendos `RESEND_API_KEY`, backup prap ruhet në Storage dhe lexohet në /fletore.

## 3) Ku ruhet backup-i
Supabase Storage bucket: `tepiha-photos`
Folder: `backups/YYYY-MM-DD/`
File:
- `orders.json`
- `orders.csv`
- `fletore.html`

## 4) Si ta testosh menjëherë
1. Deploy n’Vercel.
2. Hape app → **FLETORJA**.
3. Kliko **RUN BACKUP NOW**.
4. Shiko a po del **Latest backup** + linkat e download.
5. Kliko **PRINT (PDF)** — e hap HTML dhe e printon si PDF.

## 5) Nëse don me pas “fletore” edhe offline
Backup-i ruhet në Supabase Storage, pra kërkon internet për ta shkarku.
Nëse don edhe offline, mund ta shtojmë edhe “export on device” (ruajtje si file në telefon) me një klikim.
