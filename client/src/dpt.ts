// ── DPT (Data Point Type) module ──────────────────────────────────────────────

export interface DptInfoEntry {
  name: string;
  text?: string;
  unit: string;
}

// Module-level i18n translation function — updated by I18nCtx provider
export let _i18nT: (refId: string) => string | null = (_refId) => null;
export let _i18nLang = 'en-US';
export function setI18nT(fn: (refId: string) => string | null): void {
  _i18nT = fn;
}
export function setI18nLang(lang: string): void {
  _i18nLang = lang;
}

// Resolve a device's model name using stored translations and current language
export function localizedModel(device: any): string {
  if (!device) return '';
  if (_i18nLang && device.model_translations) {
    try {
      const tr =
        typeof device.model_translations === 'string'
          ? JSON.parse(device.model_translations)
          : device.model_translations;
      if (tr[_i18nLang]) return tr[_i18nLang];
    } catch (_) {}
  }
  return device.model || '';
}

// Populated at runtime from /api/dpt-info (knx_master.xml)
export let DPT_INFO: Record<string, DptInfoEntry> = {
  // DPT 1 — 1-bit boolean (fallback until server data loads)
  1.001: { name: 'DPT_Switch', unit: '' },
  1.002: { name: 'DPT_Bool', unit: '' },
  1.003: { name: 'DPT_Enable', unit: '' },
  1.004: { name: 'DPT_Ramp', unit: '' },
  1.005: { name: 'DPT_Alarm', unit: '' },
  1.006: { name: 'DPT_BinaryValue', unit: '' },
  1.007: { name: 'DPT_Step', unit: '' },
  1.008: { name: 'DPT_UpDown', unit: '' },
  1.009: { name: 'DPT_OpenClose', unit: '' },
  '1.010': { name: 'DPT_Start', unit: '' },
  1.011: { name: 'DPT_State', unit: '' },
  1.012: { name: 'DPT_Invert', unit: '' },
  1.017: { name: 'DPT_Trigger', unit: '' },
  1.018: { name: 'DPT_Occupancy', unit: '' },
  1.019: { name: 'DPT_Window_Door', unit: '' },
  1.021: { name: 'DPT_LogicalFunction', unit: '' },
  1.022: { name: 'DPT_Scene_AB', unit: '' },
  1.023: { name: 'DPT_ShutterBlinds_Mode', unit: '' },
  // DPT 2 — 2-bit controlled
  2.001: { name: 'DPT_Switch_Control', unit: '' },
  2.002: { name: 'DPT_Bool_Control', unit: '' },
  // DPT 3 — 4-bit dimming/blinds
  3.007: { name: 'DPT_Control_Dimming', unit: '' },
  3.008: { name: 'DPT_Control_Blinds', unit: '' },
  // DPT 4 — character
  4.001: { name: 'DPT_Char_ASCII', unit: '' },
  4.002: { name: 'DPT_Char_8859_1', unit: '' },
  // DPT 5 — 8-bit unsigned
  5.001: { name: 'DPT_Scaling', unit: ' %' },
  5.003: { name: 'DPT_Angle', unit: '°' },
  5.004: { name: 'DPT_Percent_U8', unit: ' %' },
  5.005: { name: 'DPT_DecimalFactor', unit: '' },
  5.006: { name: 'DPT_Tariff', unit: '' },
  '5.010': { name: 'DPT_Value_1_Ucount', unit: '' },
  // DPT 6 — 8-bit signed
  6.001: { name: 'DPT_Percent_V8', unit: ' %' },
  '6.010': { name: 'DPT_Value_1_Count', unit: '' },
  // DPT 7 — 16-bit unsigned
  7.001: { name: 'DPT_Value_2_Ucount', unit: '' },
  7.002: { name: 'DPT_TimePeriodMsec', unit: ' ms' },
  7.003: { name: 'DPT_TimePeriod10Msec', unit: ' ms' },
  7.004: { name: 'DPT_TimePeriod100Msec', unit: ' ms' },
  7.005: { name: 'DPT_TimePeriodSec', unit: ' s' },
  7.006: { name: 'DPT_TimePeriodMin', unit: ' min' },
  7.007: { name: 'DPT_TimePeriodHrs', unit: ' h' },
  7.011: { name: 'DPT_Length_mm', unit: ' mm' },
  7.012: { name: 'DPT_UElCurrentmA', unit: ' mA' },
  7.013: { name: 'DPT_Brightness', unit: ' lx' },
  // DPT 8 — 16-bit signed
  8.001: { name: 'DPT_Value_2_Count', unit: '' },
  8.002: { name: 'DPT_DeltaTimeMsec', unit: ' ms' },
  8.005: { name: 'DPT_DeltaTimeSec', unit: ' s' },
  8.006: { name: 'DPT_DeltaTimeMin', unit: ' min' },
  8.007: { name: 'DPT_DeltaTimeHrs', unit: ' h' },
  '8.010': { name: 'DPT_Percent_V16', unit: ' %' },
  8.011: { name: 'DPT_Rotation_Angle', unit: '°' },
  // DPT 9 — 16-bit float (2-byte)
  9.001: { name: 'DPT_Value_Temp', unit: ' °C' },
  9.002: { name: 'DPT_Value_Tempd', unit: ' K' },
  9.003: { name: 'DPT_Value_Tempa', unit: ' K/h' },
  9.004: { name: 'DPT_Value_Lux', unit: ' lx' },
  9.005: { name: 'DPT_Value_Wsp', unit: ' m/s' },
  9.006: { name: 'DPT_Value_Pres', unit: ' Pa' },
  9.007: { name: 'DPT_Value_Humidity', unit: ' %' },
  9.008: { name: 'DPT_Value_AirQuality', unit: ' ppm' },
  9.009: { name: 'DPT_Value_AirFlow', unit: ' m³/h' },
  '9.010': { name: 'DPT_Value_Time1', unit: ' s' },
  9.011: { name: 'DPT_Value_Time2', unit: ' ms' },
  9.012: { name: 'DPT_Value_Volt', unit: ' mV' },
  9.013: { name: 'DPT_Value_Curr', unit: ' mA' },
  9.014: { name: 'DPT_PowerDensity', unit: ' W/m²' },
  9.015: { name: 'DPT_KelvinPerPercent', unit: ' K/%' },
  9.016: { name: 'DPT_Power', unit: ' kW' },
  9.017: { name: 'DPT_Value_Volume_Flow', unit: ' l/h' },
  9.018: { name: 'DPT_Rain_Amount', unit: ' l/m²' },
  9.019: { name: 'DPT_Value_Temp_F', unit: ' °F' },
  '9.020': { name: 'DPT_Value_Wsp_kmh', unit: ' km/h' },
  9.021: { name: 'DPT_Value_AbsHumidity', unit: ' g/m³' },
  9.022: { name: 'DPT_Concentration', unit: ' μg/m³' },
  9.024: { name: 'DPT_Power_kW', unit: ' kW' },
  9.025: { name: 'DPT_Volume_Flow_l_h', unit: ' l/h' },
  // DPT 10 — time of day
  10.001: { name: 'DPT_TimeOfDay', unit: '' },
  // DPT 11 — date
  11.001: { name: 'DPT_Date', unit: '' },
  // DPT 12 — 32-bit unsigned
  12.001: { name: 'DPT_Value_4_Ucount', unit: '' },
  // DPT 13 — 32-bit signed
  13.001: { name: 'DPT_Value_4_Count', unit: '' },
  '13.010': { name: 'DPT_FlowRate_m3h', unit: ' m³/h' },
  13.011: { name: 'DPT_ActiveEnergy', unit: ' Wh' },
  13.012: { name: 'DPT_ApparantEnergy', unit: ' VAh' },
  13.013: { name: 'DPT_ReactiveEnergy', unit: ' VARh' },
  // DPT 14 — 32-bit float (4-byte) — selected common types
  '14.000': { name: 'DPT_Value_Acceleration', unit: ' m/s²' },
  14.006: { name: 'DPT_Value_AngleDeg', unit: '°' },
  14.007: { name: 'DPT_Value_AngleRad', unit: ' rad' },
  14.019: { name: 'DPT_Value_Electric_Current', unit: ' A' },
  14.027: { name: 'DPT_Value_Electric_Potential', unit: ' V' },
  14.031: { name: 'DPT_Value_Energy', unit: ' J' },
  14.032: { name: 'DPT_Value_Force', unit: ' N' },
  14.033: { name: 'DPT_Value_Frequency', unit: ' Hz' },
  14.039: { name: 'DPT_Value_Length', unit: ' m' },
  14.051: { name: 'DPT_Value_Mass', unit: ' kg' },
  14.056: { name: 'DPT_Value_Power', unit: ' W' },
  14.057: { name: 'DPT_Value_Power_Factor', unit: '' },
  14.058: { name: 'DPT_Value_Pressure', unit: ' Pa' },
  '14.060': { name: 'DPT_Value_Resistance', unit: ' Ω' },
  14.065: { name: 'DPT_Value_Speed', unit: ' m/s' },
  14.068: { name: 'DPT_Value_Temperature', unit: ' °C' },
  14.069: { name: 'DPT_Value_AbsTemp', unit: ' K' },
  '14.070': { name: 'DPT_Value_TempDiff', unit: ' K' },
  14.074: { name: 'DPT_Value_Time', unit: ' s' },
  14.075: { name: 'DPT_Value_Torque', unit: ' N·m' },
  14.076: { name: 'DPT_Value_Volume', unit: ' m³' },
  14.079: { name: 'DPT_Value_Work', unit: ' J' },
  // DPT 16 — string
  '16.000': { name: 'DPT_String_ASCII', unit: '' },
  16.001: { name: 'DPT_String_8859_1', unit: '' },
  // DPT 17 — scene
  17.001: { name: 'DPT_SceneNumber', unit: '' },
  18.001: { name: 'DPT_SceneControl', unit: '' },
  // DPT 19 — date/time
  19.001: { name: 'DPT_DateTime', unit: '' },
  // DPT 20 — HVAC enumerations
  20.001: { name: 'DPT_SCLOMode', unit: '' },
  20.002: { name: 'DPT_BuildingMode', unit: '' },
  20.003: { name: 'DPT_OccMode', unit: '' },
  '20.100': { name: 'DPT_FuelType', unit: '' },
  20.102: { name: 'DPT_HVACContrMode', unit: '' },
  20.103: { name: 'DPT_DHWMode', unit: '' },
  20.105: { name: 'DPT_HVACEmergMode', unit: '' },
  20.107: { name: 'DPT_ValveMode', unit: '' },
  20.108: { name: 'DPT_DamperMode', unit: '' },
  20.109: { name: 'DPT_HeaterMode', unit: '' },
  '20.110': { name: 'DPT_FanMode', unit: '' },
  // DPT 232 — RGB colour
  '232.600': { name: 'DPT_Colour_RGB', unit: '' },
};

export interface SpaceUsage {
  id: string;
  text: string;
}

export let SPACE_USAGES: SpaceUsage[] = []; // populated from /api/space-usages
export function setSpaceUsages(data: SpaceUsage[]): void {
  SPACE_USAGES = data;
}
export const spaceUsageMap = (): Record<string, string> =>
  Object.fromEntries(SPACE_USAGES.map((su) => [su.id, su.text]));

export function setDptInfo(data: Record<string, DptInfoEntry>): void {
  DPT_INFO = data;
}

export function normalizeDpt(dpt: string | number): string {
  if (!dpt) return '';
  const s = dpt.toString().trim();
  // ETS format: 'DPT-9-1' or 'DPST-9-1' → '9.001'
  const m = s.match(/^DPS?T-(\d+)-(\d+)$/i);
  if (m) return `${m[1]}.${m[2]!.padStart(3, '0')}`;
  // Already dotted: '9.1' → '9.001', '9.001' stays
  if (s.includes('.')) {
    const [main, sub] = s.split('.') as [string, string];
    return `${main}.${sub.padStart(3, '0')}`;
  }
  return s;
}

export function dptInfo(dpt: string | number): DptInfoEntry {
  if (!dpt) return { name: '', text: '', unit: '' };
  const d = normalizeDpt(dpt);
  return (
    DPT_INFO[d] ||
    DPT_INFO[d.split('.')[0] + '.001'] || { name: d, text: '', unit: '' }
  );
}

export function dptUnit(dpt: string | number): string {
  return dptInfo(dpt).unit;
}

export function dptToRefId(dpt: string | number): string | null {
  const d = normalizeDpt(dpt);
  if (!d) return null;
  const [major, sub] = d.split('.') as [string, string];
  return 'DPST-' + parseInt(major) + '-' + parseInt(sub);
}

export function dptName(dpt: string | number): string {
  const { name, text } = dptInfo(dpt);
  // Try i18n translation first
  const refId = dptToRefId(dpt);
  const translated = refId && _i18nT(refId);
  if (translated) return translated;
  // Prefer human-readable text (e.g. "temperature (°C)") over internal code name
  return text || name;
}

export function dptTitle(dpt: string | number): string | undefined {
  if (!dpt) return undefined;
  const { name, text, unit } = dptInfo(dpt);
  const refId = dptToRefId(dpt);
  const translated = refId && _i18nT(refId);
  const label = translated || text || name;
  if (!label) return undefined;
  // text already includes unit in parens for most DPTs (e.g. "temperature (°C)")
  return translated
    ? `${translated} — ${name}`
    : text
      ? `${text} — ${name}`
      : unit
        ? `${name} (${unit.trim()})`
        : name;
}
