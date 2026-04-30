export const dynamic = 'force-dynamic';

const box = {
  minHeight: '100vh',
  background: '#05070d',
  color: '#fff',
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
};

const card = {
  maxWidth: 720,
  width: '100%',
  borderRadius: 18,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)',
  padding: 20,
};

export default function DebugDisabledPage() {
  return (
    <div style={box}>
      <div style={card}>
        <div style={{ fontWeight: 900, letterSpacing: 2, fontSize: 20 }}>DEBUG ËSHTË HEQUR</div>
        <div style={{ opacity: 0.85, marginTop: 10, lineHeight: 1.5 }}>
          Sistemi verbose i debug-ut është çaktivizuar. Aplikacioni ruan vetëm incidente të thjeshta në DB që të mos rëndohet startup-i dhe të mos bllokohet vetë nga debug-u.
        </div>
      </div>
    </div>
  );
}
