export default function RootLayout({ children }) {
  return (
    <html lang="sq">
      <body style={{ background: '#0b0f1a', color: '#fff', margin: 0 }}>
        {children}
      </body>
    </html>
  );
}
