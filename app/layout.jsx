import './globals.css';
import AuthGate from '../components/AuthGate';
import PwaWarmup from '@/components/PwaWarmup';

export const metadata = {
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'TEPIHA' },
  themeColor: '#000000',
  manifest: '/manifest.json',
  title: 'TEPIHA',
  description: 'Carpet cleaning workflow app (Next.js + Supabase).',
};

export default function RootLayout({ children }) {
  return (
    <html lang="sq">
      <body>
        <PwaWarmup />
        
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}