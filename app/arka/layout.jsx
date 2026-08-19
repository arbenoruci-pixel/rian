import './arka.css';
import ArkaDailyCloseShortcut from '@/components/ArkaDailyCloseShortcut.jsx';

export default function ArkaLayout({ children }) {
  return (
    <div className="arka-shell">
      <div className="arka-container">
        {children}
        <ArkaDailyCloseShortcut />
      </div>
    </div>
  );
}
