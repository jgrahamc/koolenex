import { useC } from '../theme.js';

export function SettingsView({ theme, onThemeChange, dptMode, onDptModeChange }) {
  const C = useC();

  return (
    <div className="fi" style={{ flex: 1, padding: 40, overflow: 'auto' }}>
      <div style={{ maxWidth: 480 }}>
        <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 16, color: C.text, marginBottom: 24 }}>Settings</div>

        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20, marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: C.accent, fontWeight: 600, letterSpacing: '0.08em', marginBottom: 16 }}>APPEARANCE</div>
          <div style={{ fontSize: 9, color: C.dim, marginBottom: 8 }}>THEME</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {['dark', 'light'].map(t => (
              <div key={t} onClick={() => onThemeChange(t)}
                style={{ flex: 1, padding: '10px 14px', borderRadius: 6, border: `2px solid ${theme === t ? C.accent : C.border}`, background: t === 'dark' ? '#060a10' : '#f0f4f8', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14 }}>{t === 'dark' ? '◑' : '○'}</span>
                <div>
                  <div style={{ fontSize: 11, color: t === 'dark' ? '#e0eeff' : '#1a2a3a', fontWeight: theme === t ? 600 : 400 }}>{t.charAt(0).toUpperCase() + t.slice(1)}</div>
                  <div style={{ fontSize: 9, color: t === 'dark' ? '#5a80a8' : '#7090a8' }}>{t === 'dark' ? 'Dark background' : 'Light background'}</div>
                </div>
                {theme === t && <span style={{ marginLeft: 'auto', color: C.accent, fontSize: 14 }}>✓</span>}
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20, marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: C.accent, fontWeight: 600, letterSpacing: '0.08em', marginBottom: 16 }}>DATA POINT TYPES</div>
          <div style={{ fontSize: 9, color: C.dim, marginBottom: 8 }}>DPT DISPLAY FORMAT</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { id: 'numeric',  label: 'Numeric',  sub: 'e.g. DPST-9-1',           icon: '#' },
              { id: 'formal',   label: 'Formal',   sub: 'e.g. DPT_Value_Temp',     icon: 'Fn' },
              { id: 'friendly', label: 'Friendly', sub: 'e.g. temperature (\u00b0C)', icon: 'Aa' },
            ].map(({ id, label, sub, icon }) => (
              <div key={id} onClick={() => onDptModeChange(id)}
                style={{ flex: 1, padding: '10px 14px', borderRadius: 6, border: `2px solid ${dptMode === id ? C.accent : C.border}`, background: C.bg, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: C.muted, fontFamily: 'monospace' }}>{icon}</span>
                <div>
                  <div style={{ fontSize: 11, color: C.text, fontWeight: dptMode === id ? 600 : 400 }}>{label}</div>
                  <div style={{ fontSize: 9, color: C.dim }}>{sub}</div>
                </div>
                {dptMode === id && <span style={{ marginLeft: 'auto', color: C.accent, fontSize: 14 }}>✓</span>}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 9, color: C.dim, marginTop: 8 }}>Hover over a DPT value to see the other two formats.</div>
        </div>

        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20 }}>
          <div style={{ fontSize: 11, color: C.accent, fontWeight: 600, letterSpacing: '0.08em', marginBottom: 12 }}>ABOUT</div>
          <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.8 }}>
            koolenex — open source KNX project manager<br />
            Backend: Node.js + Express + SQLite<br />
            Protocol: KNXnet/IP (tunneling + routing)<br />
            ETS6 .knxproj import supported<br />
            <span style={{ color: C.dim }}>v0.1.0-alpha</span>
          </div>
        </div>
      </div>
    </div>
  );
}
