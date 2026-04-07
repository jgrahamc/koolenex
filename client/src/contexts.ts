import { createContext, useContext } from 'react';
import { normalizeDpt, dptInfo, dptToRefId, _i18nT } from './dpt.ts';

export type DptMode = 'numeric' | 'formal' | 'friendly';

export const DptCtx = createContext<DptMode>('numeric');
export const PinContext = createContext<string | null>(null);

/**
 * Three display modes for DPT:
 *   numeric  — "DPST-9-1"
 *   formal   — "DPT_Value_Temp"
 *   friendly — "temperature (°C)"
 * Hover shows the other two.
 */
export function useDpt(): {
  display: (raw: string | number) => string;
  hover: (raw: string | number) => string | undefined;
} {
  const mode = useContext(DptCtx);

  const formats = (raw: string | number) => {
    if (!raw) return { numeric: '', formal: '', friendly: '' };
    const norm = normalizeDpt(raw);
    const info = dptInfo(raw);
    const refId = dptToRefId(raw);
    const translated = refId && _i18nT(refId);

    const numeric = String(raw); // keep original format (e.g., "DPST-9-1" or "9.001")
    const formal = info.name || norm;
    const friendly = translated || info.text || '';
    return { numeric, formal, friendly };
  };

  return {
    display: (raw: string | number) => {
      if (!raw) return '—';
      const f = formats(raw);
      if (mode === 'formal') return f.formal || String(raw);
      if (mode === 'friendly') return f.friendly || f.formal || String(raw);
      return f.numeric;
    },
    hover: (raw: string | number) => {
      if (!raw) return undefined;
      const f = formats(raw);
      const parts: string[] = [];
      if (mode !== 'numeric') parts.push(f.numeric);
      if (mode !== 'formal') parts.push(f.formal);
      if (mode !== 'friendly' && f.friendly) parts.push(f.friendly);
      return parts.filter(Boolean).join(' — ') || undefined;
    },
  };
}
