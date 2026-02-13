import './globals.css';
import AuthGate from '../components/AuthGate';
import ServiceWorkerRegister from '../components/ServiceWorkerRegister';

export const metadata = {
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'TEPIHA' },
  title: 'TEPIHA',
  description: 'Carpet cleaning workflow app (Next.js + Supabase).',
};

export default function RootLayout({ children }) {
  return (
    <html lang="sq">
      <body>
        <AuthGate>{children}</AuthGate>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
