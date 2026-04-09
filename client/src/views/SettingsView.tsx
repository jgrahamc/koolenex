import styles from './SettingsView.module.css';

interface SettingsViewProps {
  theme: string;
  onThemeChange: (theme: string) => void;
  dptMode: string;
  onDptModeChange: (mode: string) => void;
}

export function SettingsView({
  theme,
  onThemeChange,
  dptMode,
  onDptModeChange,
}: SettingsViewProps) {
  return (
    <div className={`fi ${styles.root}`}>
      <div className={styles.inner}>
        <div className={styles.heading}>Settings</div>

        <div className={styles.card}>
          <div className={styles.sectionTitle}>APPEARANCE</div>
          <div className={styles.label}>THEME</div>
          <div className={styles.optionRow}>
            {['dark', 'light'].map((t) => (
              <div
                key={t}
                onClick={() => onThemeChange(t)}
                className={`${theme === t ? styles.themeOptionActive : styles.themeOptionInactive} ${t === 'dark' ? styles.themeOptionDark : styles.themeOptionLight}`}
              >
                <span className={styles.themeIcon}>
                  {t === 'dark' ? '◑' : '○'}
                </span>
                <div>
                  <div
                    className={`${t === 'dark' ? styles.themeLabelDark : styles.themeLabelLight}${theme === t ? ` ${styles.themeLabelActive}` : ''}`}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </div>
                  <div
                    className={
                      t === 'dark' ? styles.themeSubDark : styles.themeSubLight
                    }
                  >
                    {t === 'dark' ? 'Dark background' : 'Light background'}
                  </div>
                </div>
                {theme === t && <span className={styles.checkMark}>✓</span>}
              </div>
            ))}
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.sectionTitle}>DATA POINT TYPES</div>
          <div className={styles.label}>DPT DISPLAY FORMAT</div>
          <div className={styles.optionRow}>
            {[
              {
                id: 'numeric',
                label: 'Numeric',
                sub: 'e.g. DPST-9-1',
                icon: '#',
              },
              {
                id: 'formal',
                label: 'Formal',
                sub: 'e.g. DPT_Value_Temp',
                icon: 'Fn',
              },
              {
                id: 'friendly',
                label: 'Friendly',
                sub: 'e.g. temperature (°C)',
                icon: 'Aa',
              },
            ].map(({ id, label, sub, icon }) => (
              <div
                key={id}
                onClick={() => onDptModeChange(id)}
                className={
                  dptMode === id
                    ? styles.dptOptionActive
                    : styles.dptOptionInactive
                }
              >
                <span className={styles.dptIcon}>{icon}</span>
                <div>
                  <div
                    className={
                      dptMode === id ? styles.dptLabelActive : styles.dptLabel
                    }
                  >
                    {label}
                  </div>
                  <div className={styles.dptSub}>{sub}</div>
                </div>
                {dptMode === id && <span className={styles.checkMark}>✓</span>}
              </div>
            ))}
          </div>
          <div className={styles.dptHint}>
            Hover over a DPT value to see the other two formats.
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.sectionTitleSmall}>ABOUT</div>
          <div className={styles.aboutText}>
            koolenex — open source KNX project manager
            <br />
            Backend: Node.js + Express + SQLite
            <br />
            Protocol: KNXnet/IP (tunneling + routing)
            <br />
            ETS6 .knxproj import supported
            <br />
            <span className={styles.versionDim}>v0.1.0-alpha</span>
          </div>
        </div>
      </div>
    </div>
  );
}
