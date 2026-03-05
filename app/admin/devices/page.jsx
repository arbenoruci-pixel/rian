import { redirect } from 'next/navigation';

// Ky URL është ruajtur vetëm për kompatibilitet.
// Dashboard-i i pajisjeve + stafit tash është te ARKA.
export default function AdminDevicesRedirectPage() {
  redirect('/arka/puntoret');
}
