// LEGACY ALIAS WRAPPER ONLY
// Runtime aktiv përdor src/generated/routes.generated.jsx për këtë alias.
// Ky file nuk është entry point aktiv i runtime-it të ri.
// Mbahet vetëm si wrapper i qartë historik për redirect te /arka/stafi.

import { redirect } from 'next/navigation';

// Ky URL është ruajtur vetëm për kompatibilitet.
// Dashboard-i i pajisjeve + stafit tash është te ARKA.
export default function AdminDevicesRedirectPage() {
  redirect('/arka/stafi');
}
