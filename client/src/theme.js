import { createContext, useContext } from 'react';

export const DARK_C = {
  bg: '#060a10', surface: '#0b1220', border: '#1a2a44', border2: '#1e3355',
  text: '#e0eeff', muted: '#8ab8e0', dim: '#5a80a8',
  accent: '#00b4ff', green: '#00ff9f', amber: '#ffcc00', red: '#ff4466', purple: '#c084fc',
  actuator: '#00b4ff', sensor: '#00ff9f', router: '#ffcc00',
  inputBg: '#080b0f', sidebar: '#060810', hover: '#0f1620', selected: '#0c1830',
};
export const LIGHT_C = {
  bg: '#f0f4f8', surface: '#ffffff', border: '#d0d8e4', border2: '#b0c4d8',
  text: '#1a2a3a', muted: '#3a5a78', dim: '#7090a8',
  accent: '#0066cc', green: '#008c48', amber: '#b06000', red: '#cc2244', purple: '#7c3aed',
  actuator: '#0066cc', sensor: '#008c48', router: '#b06000',
  inputBg: '#e8eef4', sidebar: '#e8eef4', hover: '#e8eef4', selected: '#d4e8f8',
};
export const STATUS_COLOR = { programmed: '#22c55e', modified: '#3b82f6', unassigned: '#f59e0b', error: '#ef4444' };
export const SPACE_COLOR = { Building: '#3d8ef0', Floor: '#a855f7', Stairway: '#f59e0b', Corridor: '#4a5878', Room: '#22c55e', DistributionBoard: '#ef4444', Undefined: '#4a5878' };
export const ThemeCtx = createContext(DARK_C);
export const useC = () => useContext(ThemeCtx);
export const MediumCtx = createContext({});
export const MaskCtx = createContext({});
export const I18nCtx = createContext({ lang: 'en-US', languages: [], t: (refId) => null });
