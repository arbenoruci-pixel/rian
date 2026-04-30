export default function Loading() {
  return (
    <main
      aria-label="Loading"
      style={{
        minHeight: '100dvh',
        background: '#050814',
        color: '#f7fbff',
      }}
    >
      <div
        style={{
          maxWidth: 540,
          margin: '0 auto',
          padding: '20px 16px 32px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 18,
          }}
        >
          <div
            style={{
              fontSize: 34,
              fontWeight: 900,
              letterSpacing: '-0.03em',
              lineHeight: 1,
            }}
          >
            <span style={{ color: '#f7fbff' }}>TEPIHA </span>
            <span style={{ color: '#3f82ff' }}>PRO</span>
          </div>

          <div
            aria-hidden="true"
            style={{
              width: 58,
              height: 58,
              borderRadius: '50%',
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(255,255,255,0.06)',
              boxShadow: '0 10px 24px rgba(0,0,0,0.28)',
            }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 10,
              color: 'rgba(255,255,255,0.72)',
              fontSize: 13,
              fontWeight: 800,
              letterSpacing: '0.12em',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: 22, lineHeight: 1 }}>
              🔎
            </span>
            <span>KËRKO POROSINË</span>
          </div>

          <div
            aria-hidden="true"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 122px',
              gap: 12,
            }}
          >
            <div
              style={{
                height: 72,
                borderRadius: 26,
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            />
            <div
              style={{
                height: 72,
                borderRadius: 26,
                background: '#3f82ff',
                opacity: 0.9,
              }}
            />
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginTop: 18,
            marginBottom: 16,
            color: 'rgba(255,255,255,0.72)',
            fontSize: 13,
            fontWeight: 800,
            letterSpacing: '0.12em',
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 22, lineHeight: 1 }}>
            ⚙️
          </span>
          <span>ZGJEDH MODULIN</span>
        </div>

        <div
          aria-hidden="true"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 18,
          }}
        >
          {[0, 1, 2, 3, 4, 5, 6].map((item, idx) => (
            <div
              key={item}
              style={{
                minHeight: idx === 2 ? 180 : 146,
                borderRadius: 28,
                padding: 18,
                border: '1px solid rgba(255,255,255,0.08)',
                background:
                  'radial-gradient(circle at top left, rgba(20,35,72,0.95), rgba(4,8,20,0.98) 62%)',
                boxShadow: '0 16px 36px rgba(0,0,0,0.28)',
              }}
            >
              <div
                style={{
                  width: 68,
                  height: 68,
                  borderRadius: 22,
                  background: 'rgba(70,110,255,0.18)',
                  marginBottom: 18,
                }}
              />
              <div
                style={{
                  height: 20,
                  width: idx === 5 ? '88%' : idx === 6 ? '72%' : '64%',
                  borderRadius: 10,
                  background: 'rgba(255,255,255,0.88)',
                  marginBottom: 12,
                }}
              />
              <div
                style={{
                  height: 14,
                  width: idx === 5 ? '98%' : '78%',
                  borderRadius: 8,
                  background: 'rgba(255,255,255,0.24)',
                  marginBottom: 8,
                }}
              />
              <div
                style={{
                  height: 14,
                  width: idx === 5 ? '92%' : idx === 6 ? '94%' : '62%',
                  borderRadius: 8,
                  background: 'rgba(255,255,255,0.16)',
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
