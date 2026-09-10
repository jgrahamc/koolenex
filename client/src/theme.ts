import { createContext } from 'react';
import type { MaskVersionEntry } from '../../shared/types.ts';

export const STATUS_COLOR: Record<string, string> = {
  programmed: '#22c55e',
  modified: '#3b82f6',
  unassigned: '#f59e0b',
  error: '#ef4444',
};

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
// The entry, not just its name: GET /mask-versions returns
// { name, managementModel, medium } per mask, and the device panel reads all
// three. Declared as Record<string, string> until 2026-09-10, which is why
// its readers had to be typed `any`.
export const MaskCtx = createContext<Record<string, MaskVersionEntry>>({});

export interface I18nContextValue {
  lang: string;
  /** From GET /translations: each language's id and display name. Declared
   *  as string[] until 2026-09-10, though it always held these objects. */
  languages: { id: string; name: string }[];
  t: (refId: string) => string | null;
}

export const I18nCtx = createContext<I18nContextValue>({
  lang: 'en-US',
  languages: [],
  t: (_refId: string) => null,
});
