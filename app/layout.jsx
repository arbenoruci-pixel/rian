import './globals.css';
import AuthGate from '../components/AuthGate';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';
import HiddenDebug from '@/components/HiddenDebug';
import VersionGuard from '@/components/VersionGuard';
import OfflineSyncRunner from '@/components/OfflineSyncRunner';

export const metadata = {
  title: 'TEPIHA',
  description: 'Carpet cleaning workflow app (Next.js + Supabase).',
};
export const dynamic = 'force-dynamic';
export const revalidate = 0;


export default function RootLayout({ children }) {
  return (
    <html lang="sq">
      <body>
        <VersionGuard />
        <HiddenDebug />
        <ServiceWorkerRegister />
        <OfflineSyncRunner />
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}