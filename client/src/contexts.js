import { createContext, useContext } from 'react';
import { normalizeDpt, dptInfo, dptToRefId, _i18nT } from './dpt.js';

export const DptCtx = createContext('numeric');
export const PinContext = createContext(null);

/**
 * Three display modes for DPT:
 *   numeric  — "DPST-9-1"
 *   formal   — "DPT_Value_Temp"
 *   friendly — "temperature (°C)"
 * Hover shows the other two.
 */
export function useDpt() {
  const mode = useContext(DptCtx);

  const formats = (raw) => {
    if (!raw) return { numeric: '', formal: '', friendly: '' };
    const norm = normalizeDpt(raw);
    const info = dptInfo(raw);
    const refId = dptToRefId(raw);
    const translated = refId && _i18nT(refId);

    const numeric = raw; // keep original format (e.g., "DPST-9-1" or "9.001")
    const formal = info.name || norm;
    const friendly = translated || info.text || '';
    return { numeric, formal, friendly };
  };

  return {
    display: (raw) => {
      if (!raw) return '—';
      const f = formats(raw);
      if (mode === 'formal') return f.formal || raw;
      if (mode === 'friendly') return f.friendly || f.formal || raw;
      return f.numeric;
    },
    hover: (raw) => {
      if (!raw) return undefined;
      const f = formats(raw);
      const parts = [];
      if (mode !== 'numeric')  parts.push(f.numeric);
      if (mode !== 'formal')   parts.push(f.formal);
      if (mode !== 'friendly' && f.friendly) parts.push(f.friendly);
      return parts.filter(Boolean).join(' — ') || undefined;
    },
  };
}
