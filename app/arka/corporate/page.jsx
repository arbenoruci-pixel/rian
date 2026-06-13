// LEGACY ALIAS WRAPPER ONLY
// Runtime aktiv përdor src/generated/routes.generated.jsx për këtë alias.
// Ky file nuk është entry point aktiv i runtime-it të ri.
// Mbahet vetëm si wrapper i qartë historik për redirect te /arka/obligimet.

import { redirect } from '@/lib/routerCompat.jsx';

export default function RedirectToObligimet() {
  redirect('/arka/obligimet');
}
