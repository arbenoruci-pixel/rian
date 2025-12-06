import './globals.css';

export const metadata = {
  title: 'Tepiha • PRANIMI',
  description: 'Carpet cleaning workflow app (Next.js + Supabase).',
};

export default function RootLayout({ children }) {
  return (
    <html lang="sq">
      <body>
        {children}
      </body>
    </html>
  );
}
