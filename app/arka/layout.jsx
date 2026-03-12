import './arka.css';

export default function ArkaLayout({ children }) {
  return (
    <div className="arka-shell">
      <div className="arka-container">{children}</div>
    </div>
  );
}
