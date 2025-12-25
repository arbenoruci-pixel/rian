// ARKA layout wrapper (PRO spacing) – applies to ALL /arka/* routes
export const dynamic = 'force-dynamic';

import './arka.css';

export default function ArkaLayout({ children }) {
  return (
    <div className="arkaProRoot">
      <div className="arkaProContainer">
        {children}
      </div>
    </div>
  );
}
