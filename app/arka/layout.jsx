'use client';

import './arka.css';
import Link from 'next/link';

export default function ArkaLayout({ children }) {
  return (
    <div className="arkaShell">
      <div className="arkaTopbar">
        <Link href="/" className="arkaTopBtn" aria-label="HOME">⬅︎</Link>
        <div className="arkaTopTitle">ARKA</div>
        <div className="arkaTopRight" />
      </div>

      <div className="arkaContainer">
        {children}
      </div>
    </div>
  );
}
