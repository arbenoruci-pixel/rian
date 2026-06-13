// Shared UI styles for Transport Board modules
// Keep design identical to the original app/transport/board/page.jsx

export const ui = {
  page: { backgroundColor: "#000000", minHeight: "100vh", color: "#FFFFFF", fontFamily: "-apple-system, BlinkMacSystemFont, Roboto, sans-serif", display: "flex", flexDirection: "column" },
  header: { padding: "16px 16px 0 16px", backgroundColor: "#000000", position: "sticky", top: 0, zIndex: 10 },
  headerTop: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  avatarProfile: { width: 36, height: 36, borderRadius: "50%", backgroundColor: "#333", color: "#AAA", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: "bold" },
  btnCompose: { width: 36, height: 36, borderRadius: "50%", backgroundColor: "#333", border: "none", color: "#fff", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
  btnSmall: { background: '#1C1C1E', border: 'none', color: '#fff', fontSize: 12, padding: '4px 8px', borderRadius: 8, cursor: 'pointer' },
  title: { fontSize: 32, fontWeight: "800", margin: "0 0 16px 0", letterSpacing: 0.5 },
  tabsContainer: { display: "flex", gap: 10, paddingBottom: 16, borderBottom: "1px solid #1C1C1E" },
  tab: { backgroundColor: "#1C1C1E", color: "#FFF", border: "none", padding: "8px 16px", borderRadius: 20, fontSize: 14, fontWeight: "600", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 },
  tabActive: { backgroundColor: "#8E44AD", color: "#FFF", border: "none", padding: "8px 16px", borderRadius: 20, fontSize: 14, fontWeight: "600", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 },
  badge: { backgroundColor: "#FFF", color: "#000", fontSize: 10, padding: "2px 6px", borderRadius: 10, fontWeight: "800" },
  dot: { width: 10, height: 10, borderRadius: 999, backgroundColor: "#FF3B30", display: "inline-block", marginLeft: 8, boxShadow: "0 0 0 2px rgba(0,0,0,0.35)" },
  listContainer: { flex: 1, overflowY: "auto" },
  centerMsg: { textAlign: "center", color: "#555", marginTop: 40, fontSize: 14 },
  row: { display: "flex", padding: "12px 16px", cursor: "pointer", borderBottom: "1px solid #111", alignItems: 'center' },
  rowLeft: { marginRight: 14 },
  circleAvatar: { width: 48, height: 48, borderRadius: "50%", backgroundColor: "#2ECC71", color: "#000", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: "900", boxShadow: "0 2px 5px rgba(0,0,0,0.3)" },
  rowMiddle: { flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", overflow: "hidden" },
  rowHeader: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 },
  clientName: { color: "#FFFFFF", fontSize: 16, fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "80%" },
  timeStamp: { color: "#888", fontSize: 12, fontWeight: "500" },
  subjectLine: { color: "#CCC", fontSize: 14, marginBottom: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  previewText: { color: "#777", fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },

  // Pikapi sub-tabs (MARRJE / DORËZIM) + SELECT ALL ne mes
  subTabsWrap: { display: "flex", gap: 8, alignItems: "center", padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.08)", position: "sticky", top: 0, background: "#000", zIndex: 5 },
  subTab: { padding: "8px 10px", borderRadius: 12, background: "rgba(255,255,255,0.06)", color: "#fff", border: "1px solid rgba(255,255,255,0.08)", fontWeight: 900, fontSize: 10, textTransform: "uppercase", whiteSpace: "nowrap" },
  subTabActiveIn: { padding: "8px 10px", borderRadius: 12, background: "rgba(10,132,255,0.22)", color: "#fff", border: "1px solid rgba(10,132,255,0.55)", fontWeight: 900, fontSize: 10, textTransform: "uppercase", whiteSpace: "nowrap" },
  subTabActiveOut: { padding: "8px 10px", borderRadius: 12, background: "rgba(52,199,89,0.18)", color: "#fff", border: "1px solid rgba(52,199,89,0.55)", fontWeight: 900, fontSize: 10, textTransform: "uppercase", whiteSpace: "nowrap" },
  miniBtnMid: { padding: "8px 10px", borderRadius: 12, background: "rgba(255,255,255,0.06)", color: "#fff", border: "1px solid rgba(255,255,255,0.10)", fontWeight: 900, fontSize: 10, textTransform: "uppercase", whiteSpace: "nowrap" },
  rowSelected: { outline: "2px solid rgba(10,132,255,0.55)", background: "rgba(10,132,255,0.10)" },
  rowRight: { display: "flex", alignItems: "center", paddingLeft: 10 },

  checkOff: { width: 30, height: 30, borderRadius: 10, border: "2px solid rgba(255,255,255,0.22)", background: "rgba(255,255,255,0.06)", color: "#fff", fontWeight: 900 },
  checkOn: { width: 30, height: 30, borderRadius: 10, border: "2px solid rgba(52,199,89,0.65)", background: "rgba(52,199,89,0.20)", color: "#fff", fontWeight: 900 },

  bulkBar: { position: "fixed", left: 12, right: 12, bottom: 86, display: "flex", gap: 10, padding: 10, borderRadius: 18, background: "rgba(0,0,0,0.88)", border: "1px solid rgba(255,255,255,0.10)", backdropFilter: "blur(10px)", zIndex: 50 },
  bulkBtn: { flex: 1, padding: "12px 12px", borderRadius: 14, background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.10)", fontWeight: 900, textTransform: "uppercase", fontSize: 12 },

  checkboxEmpty: { width: 22, height: 22, borderRadius: "50%", border: "2px solid #555" },
  checkboxSelected: { width: 22, height: 22, borderRadius: "50%", backgroundColor: "#007AFF", border: "none", display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 'bold', color: "#fff" },

  floatingBar: { position: "fixed", bottom: 30, left: "50%", transform: "translateX(-50%)", height: 70, backgroundColor: "rgba(28,28,30,0.95)", backdropFilter: 'blur(12px)', borderRadius: 35, display: "flex", alignItems: "center", padding: "0 20px", gap: 20, zIndex: 50, boxShadow: "0 10px 30px rgba(0,0,0,0.5)", border: "1px solid rgba(255,255,255,0.1)" },
  floatBtn: { background: 'none', border: 'none', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', gap: 2, minWidth: 50 },
  floatBtnLink: { textDecoration: 'none', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', gap: 2, minWidth: 50 },

  modalOverlay: { position: "fixed", inset: 0, backgroundColor: "#000", zIndex: 9999, display: "flex", flexDirection: "column", animation: "slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)" },
  modalShell: { flex: 1, display: "flex", flexDirection: "column", backgroundColor: "#000", position: 'relative' },
  modalTop: { height: 50, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", backgroundColor: "#111", borderBottom: "1px solid #222", zIndex: 2 },
  btnCloseModal: { background: "none", border: "none", color: "#007AFF", fontSize: 16, cursor: "pointer", fontWeight: "600" },
  iframe: { flex: 1, border: "none", backgroundColor: "#000", zIndex: 1 },

  routeRow: { display: 'flex', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid #222' },
  routeIndex: { width: 30, height: 30, borderRadius: '50%', background: '#333', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', marginRight: 12 },
  btnIcon: { width: 36, height: 36, borderRadius: 8, background: '#1C1C1E', border: 'none', color: '#fff', cursor: 'pointer' },
  btnMapIcon: { width: 36, height: 36, borderRadius: 8, background: '#007AFF', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 18 },

  msgRow: { display: 'flex', alignItems: 'center', padding: '14px', background: '#111', borderRadius: 12, marginBottom: 10 },
  btnSend: { padding: '8px 16px', borderRadius: 20, background: '#34C759', color: '#fff', border: 'none', fontWeight: 'bold', cursor: 'pointer' },

  btnPrimary: { padding: '12px 14px', borderRadius: 14, background: '#0A84FF', color: '#fff', border: '1px solid rgba(255,255,255,0.12)', fontWeight: 900, cursor: 'pointer', textTransform: 'uppercase' },
  btnSecondary: { padding: '12px 14px', borderRadius: 14, background: '#1C1C1E', color: '#fff', border: '1px solid rgba(255,255,255,0.12)', fontWeight: 900, cursor: 'pointer', textTransform: 'uppercase' },
  chip: { padding: '8px 10px', borderRadius: 14, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff', cursor: 'pointer', textTransform: 'uppercase', fontSize: 12 },
  input: { width: '100%', padding: '10px 12px', borderRadius: 14, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff', outline: 'none' },

  toolsSheet: { width: "92%", maxWidth: 520, background: "#0b0b0c", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 18, padding: 14 },
  toolsHeader: { padding: "4px 4px 12px 4px" },
  toolsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  toolBtnBig: { padding: 12, borderRadius: 16, background: "rgba(255,255,255,0.06)", color: "#fff", border: "1px solid rgba(255,255,255,0.10)", fontWeight: 900, textTransform: "uppercase", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 84 },

  bottomBar: { position: "fixed", bottom: 0, left: 0, right: 0, height: 60, backgroundColor: "#111", borderTop: "1px solid #1C1C1E", display: "flex", justifyContent: "space-around", alignItems: "center", zIndex: 20, paddingBottom: "env(safe-area-inset-bottom)" },
};
