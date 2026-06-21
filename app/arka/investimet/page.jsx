// LEGACY ALIAS WRAPPER ONLY
// /arka/investimet is an old entry point. Keep a safe fallback to the main ARKA screen.

import { redirect } from '@/lib/routerCompat.jsx';

export default function RedirectArkaInvestimet() {
  redirect('/arka');
}
