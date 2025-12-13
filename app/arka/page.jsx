'use client';

import { useEffect, useState } from 'react';
import Script from 'next/script';

export default function ArkaPage() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Kjo siguron që jemi NË SHFLETUES, jo në server
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div style={{ padding: 20 }}>
        <h2>ARKA</h2>
        <p>Po ngarkohet...</p>
      </div>
    );
  }

  return (
    <>
      {/* Ngarko logjikën ARKA vetëm në browser */}
      <Script
        src="/assets/arka.js"
        strategy="afterInteractive"
        onLoad={() => {
          console.log('✅ ARKA script u ngarkua');
        }}
      />

      <div style={{ padding: 20 }}>
        <h2>ARKA</h2>

        <p>Moduli ARKA është aktiv.</p>

        <div style={{ marginTop: 20 }}>
          <button
            onClick={() => {
              const pin = prompt('Shkruaj PIN-in');
              if (!pin) return;
              window.TepihaArka?.loginWithPin(pin);
            }}
          >
            LOGIN ME PIN
          </button>

          <button
            style={{ marginLeft: 10 }}
            onClick={() => {
              console.log(
                '👥 USERS:',
                window.TepihaArka?.listUsers()
              );
            }}
          >
            SHFAQ PËRDORUESIT (ADMIN)
          </button>
        </div>
      </div>
    </>
  );
}