// LEGACY ALIAS WRAPPER ONLY
// Runtime aktiv përdor src/generated/routes.generated.jsx për këtë alias.
// Ky file nuk është entry point aktiv i runtime-it të ri.
// Mbahet vetëm si wrapper i qartë historik për redirect te /arka.

import { redirect } from 'next/navigation';

export default function RedirectToArka() {
  redirect('/arka');
}
