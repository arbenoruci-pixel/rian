'use client';

import Script from 'next/script';

export default function ArkaPage() {
  // IMPORTANT:
  // No localStorage usage (or imports that use it) at module scope.
  // Everything ARKA runs in /public/assets/arka.js afterInteractive.
  return (
    <main style={{ padding: 12 }}>
      <div id="arkaApp" />

      <Script src="/assets/arka.js" strategy="afterInteractive" />
      <Script src="/assets/arka-page.js" strategy="afterInteractive" />
    </main>
  );
}
