import './globals.css';
import AuthGate from '../components/AuthGate';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';
import HiddenDebug from '@/components/HiddenDebug';
import VersionGuard from '@/components/VersionGuard';

export const metadata = {
  title: 'TEPIHA',
  description: 'Carpet cleaning workflow app (Next.js + Supabase).',
};

export default function RootLayout({ children }) {
  return (
    <html lang="sq">
      <body>
        <VersionGuard />
        <HiddenDebug />
        <ServiceWorkerRegister />
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}