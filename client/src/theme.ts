import { createContext } from 'react';

export const STATUS_COLOR = {
  programmed: '#22c55e',
  modified: '#3b82f6',
  unassigned: '#f59e0b',
  error: '#ef4444',
} as const;

export const SPACE_COLOR = {
  Building: '#3d8ef0',
  Floor: '#a855f7',
  Stairway: '#f59e0b',
  Corridor: '#4a5878',
  Room: '#22c55e',
  DistributionBoard: '#ef4444',
  Undefined: '#4a5878',
} as const;

export const MediumCtx = createContext<Record<string, string>>({});
export const MaskCtx = createContext<Record<string, string>>({});

export interface I18nContextValue {
  lang: string;
  languages: string[];
  t: (refId: string) => string | null;
}

export const I18nCtx = createContext<I18nContextValue>({
  lang: 'en-US',
  languages: [],
  t: (_refId: string) => null,
});
