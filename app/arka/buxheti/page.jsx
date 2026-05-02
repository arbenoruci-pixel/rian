// LEGACY ALIAS WRAPPER ONLY
// /arka/buxheti is an old entry point. Keep it as a safe redirect so old URLs
// cannot open a parallel ARKA screen.

import { redirect } from '@/lib/routerCompat.jsx';

export default function RedirectArkaBuxheti() {
  redirect('/arka');
}
