import './globals.css';
import AuthGate from '../components/AuthGate';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';
import HiddenDebug from '@/components/HiddenDebug';

export const metadata = {
  title: 'TEPIHA',
  description: 'Carpet cleaning workflow app (Next.js + Supabase).',
};

export default function RootLayout({ children }) {
  return (
    <html lang="sq">
      <body>
        <HiddenDebug />
        <ServiceWorkerRegister />
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}