// LEGACY ALIAS WRAPPER ONLY
// /arka/borqet is an old entry point. Obligations/debts now live under /arka/obligimet.

import { redirect } from '@/lib/routerCompat.jsx';

export default function RedirectArkaBorqet() {
  redirect('/arka/obligimet');
}
