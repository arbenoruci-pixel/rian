import './globals.css';
import AuthGate from '../components/AuthGate';
import ServiceWorkerRegister from '../components/ServiceWorkerRegister';

export const metadata = {
  title: 'TEPIHA',
  description: 'Carpet cleaning workflow app (Next.js + Supabase).',
  manifest: '/manifest.json',
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
