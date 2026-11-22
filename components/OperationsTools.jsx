import './OperationsTools.css';

export default function OperationsTools({ children, label = 'Më shumë' }) {
  return (
    <details className="operationsTools">
      <summary>{label} <span aria-hidden="true">⌄</span></summary>
      <div className="operationsToolsPanel">{children}</div>
    </details>
  );
}
