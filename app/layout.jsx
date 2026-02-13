import './globals.css';
import AuthGate from '../components/AuthGate';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';
import HiddenDebug from '@/components/HiddenDebug';
import VersionGuard from '@/components/VersionGuard';

// IMPORTANT: Avoid stale HTML caching (iOS Safari / Home Screen PWA)
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata = {
  title: 'TEPIHA',
  description: 'Carpet cleaning workflow app (Next.js + Supabase).',
};

export default function RootLayout({ children }) {
  return (
    <html lang="sq">
      <body>
        <HiddenDebug />
        <VersionGuard />
        <ServiceWorkerRegister />
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}