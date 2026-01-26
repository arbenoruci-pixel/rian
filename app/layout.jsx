import './globals.css';
import AuthGate from '../components/AuthGate';

export const metadata = {
  title: 'TEPIHA',
  description: 'Carpet cleaning workflow app (Next.js + Supabase).',
};

export default function RootLayout({ children }) {
  return (
    <html lang="sq">
      <body>
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
