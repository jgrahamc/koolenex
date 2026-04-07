/**
 * Tests for client-side DPT functions (ES module).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDpt,
  dptInfo,
  dptUnit,
  dptName,
  dptTitle,
  dptToRefId,
  setDptInfo,
  DPT_INFO,
  setI18nT,
  setI18nLang,
  localizedModel,
} from '../client/src/dpt.ts';

// ── normalizeDpt ────────────────────────────────────────────────────────────

describe('normalizeDpt', () => {
  it('converts DPST-N-N format', () => {
    assert.equal(normalizeDpt('DPST-9-1'), '9.001');
    assert.equal(normalizeDpt('DPST-14-68'), '14.068');
    assert.equal(normalizeDpt('DPST-1-1'), '1.001');
    assert.equal(normalizeDpt('DPST-232-600'), '232.600');
  });

  it('converts DPT-N-N format', () => {
    assert.equal(normalizeDpt('DPT-9-1'), '9.001');
    assert.equal(normalizeDpt('DPT-5-1'), '5.001');
  });

  it('case insensitive', () => {
    assert.equal(normalizeDpt('dpst-9-1'), '9.001');
    assert.equal(normalizeDpt('dpt-14-68'), '14.068');
  });

  it('pads short sub-type to 3 digits', () => {
    assert.equal(normalizeDpt('9.1'), '9.001');
    assert.equal(normalizeDpt('14.68'), '14.068');
    assert.equal(normalizeDpt('1.1'), '1.001');
  });

  it('passes through already-normalized format', () => {
    assert.equal(normalizeDpt('9.001'), '9.001');
    assert.equal(normalizeDpt('14.068'), '14.068');
    assert.equal(normalizeDpt('232.600'), '232.600');
  });

  it('returns empty string for null/undefined/empty', () => {
    assert.equal(normalizeDpt(null), '');
    assert.equal(normalizeDpt(undefined), '');
    assert.equal(normalizeDpt(''), '');
  });

  it('trims whitespace', () => {
    assert.equal(normalizeDpt('  9.001  '), '9.001');
    assert.equal(normalizeDpt(' DPST-9-1 '), '9.001');
  });

  it('passes through bare number', () => {
    assert.equal(normalizeDpt('9'), '9');
  });
});

// ── dptToRefId ──────────────────────────────────────────────────────────────

describe('dptToRefId', () => {
  it('converts dotted to DPST-N-N format', () => {
    assert.equal(dptToRefId('9.001'), 'DPST-9-1');
    assert.equal(dptToRefId('14.068'), 'DPST-14-68');
    assert.equal(dptToRefId('1.001'), 'DPST-1-1');
    assert.equal(dptToRefId('232.600'), 'DPST-232-600');
  });

  it('handles non-normalized input', () => {
    assert.equal(dptToRefId('DPST-9-1'), 'DPST-9-1');
    assert.equal(dptToRefId('9.1'), 'DPST-9-1');
  });

  it('returns null for empty/null', () => {
    assert.equal(dptToRefId(null), null);
    assert.equal(dptToRefId(''), null);
  });
});

// ── dptInfo ─────────────────────────────────────────────────────────────────

describe('dptInfo', () => {
  it('returns info for known DPTs', () => {
    const info = dptInfo('9.001');
    assert.equal(info.name, 'DPT_Value_Temp');
    assert.equal(info.unit, ' °C');
  });

  it('normalizes input before lookup', () => {
    const info = dptInfo('DPST-9-1');
    assert.equal(info.name, 'DPT_Value_Temp');
  });

  it('falls back to .001 subtype for unknown sub', () => {
    // 1.999 doesn't exist, should fall back to 1.001
    const info = dptInfo('1.999');
    assert.equal(info.name, 'DPT_Switch');
  });

  it('returns placeholder for completely unknown DPT', () => {
    const info = dptInfo('999.999');
    assert.equal(info.name, '999.999');
    assert.equal(info.unit, '');
  });

  it('returns empty for null/undefined', () => {
    const info = dptInfo(null);
    assert.equal(info.name, '');
    assert.equal(info.unit, '');
  });
});

// ── dptUnit ─────────────────────────────────────────────────────────────────

describe('dptUnit', () => {
  it('returns unit for known DPTs', () => {
    assert.equal(dptUnit('9.001'), ' °C');
    assert.equal(dptUnit('5.001'), ' %');
    assert.equal(dptUnit('14.056'), ' W');
    assert.equal(dptUnit('7.013'), ' lx');
  });

  it('returns empty for unitless DPTs', () => {
    assert.equal(dptUnit('1.001'), '');
    assert.equal(dptUnit('17.001'), '');
  });

  it('returns empty for null', () => {
    assert.equal(dptUnit(null), '');
  });
});

// ── dptName ─────────────────────────────────────────────────────────────────

describe('dptName', () => {
  it('returns name for known DPTs', () => {
    assert.equal(dptName('1.001'), 'DPT_Switch');
    assert.equal(dptName('9.001'), 'DPT_Value_Temp');
  });

  it('uses i18n translation when available', () => {
    setI18nT((refId: string) =>
      refId === 'DPST-9-1' ? 'temperature (°C)' : null,
    );
    assert.equal(dptName('9.001'), 'temperature (°C)');
    assert.equal(dptName('1.001'), 'DPT_Switch'); // no translation → fallback
    setI18nT(() => null); // reset
  });
});

// ── dptTitle ─────────────────────────────────────────────────────────────────

describe('dptTitle', () => {
  it('returns undefined for null/empty', () => {
    assert.equal(dptTitle(null), undefined);
    assert.equal(dptTitle(''), undefined);
  });

  it('returns name with unit for known DPTs', () => {
    const title = dptTitle('9.001');
    assert(
      title.includes('DPT_Value_Temp'),
      `should contain name, got: ${title}`,
    );
  });

  it('uses i18n translation when available', () => {
    setI18nT((refId: string) =>
      refId === 'DPST-9-1' ? 'temperature (°C)' : null,
    );
    const title = dptTitle('9.001');
    assert(
      title.includes('temperature'),
      `should contain translation, got: ${title}`,
    );
    assert(
      title.includes('DPT_Value_Temp'),
      `should contain code name, got: ${title}`,
    );
    setI18nT(() => null);
  });
});

// ── localizedModel ──────────────────────────────────────────────────────────

describe('localizedModel', () => {
  it('returns empty for null device', () => {
    assert.equal(localizedModel(null), '');
  });

  it('returns model when no translations', () => {
    assert.equal(localizedModel({ model: 'SAH/S8.6.7.1' }), 'SAH/S8.6.7.1');
  });

  it('returns model when translations is empty', () => {
    assert.equal(
      localizedModel({ model: 'SAH/S8.6.7.1', model_translations: '{}' }),
      'SAH/S8.6.7.1',
    );
  });

  it('returns translated model for matching language', () => {
    setI18nLang('de-DE');
    const dev = {
      model: 'Switch Actuator',
      model_translations: JSON.stringify({
        'de-DE': 'Schaltaktor',
        'fr-FR': 'Actionneur',
      }),
    };
    assert.equal(localizedModel(dev), 'Schaltaktor');
    setI18nLang('en-US'); // reset
  });

  it('falls back to model when language not in translations', () => {
    setI18nLang('ja-JP');
    const dev = {
      model: 'Switch Actuator',
      model_translations: JSON.stringify({ 'de-DE': 'Schaltaktor' }),
    };
    assert.equal(localizedModel(dev), 'Switch Actuator');
    setI18nLang('en-US');
  });

  it('handles model_translations as object (not string)', () => {
    setI18nLang('de-DE');
    const dev = {
      model: 'Switch Actuator',
      model_translations: { 'de-DE': 'Schaltaktor' },
    };
    assert.equal(localizedModel(dev), 'Schaltaktor');
    setI18nLang('en-US');
  });

  it('handles malformed JSON gracefully', () => {
    const dev = { model: 'Fallback', model_translations: '{bad json' };
    assert.equal(localizedModel(dev), 'Fallback');
  });
});

// ── DPT_INFO coverage: spot-check a selection of DPT entries ────────────────

describe('DPT_INFO hardcoded database', () => {
  const checks: [string, string, string][] = [
    ['1.001', 'DPT_Switch', ''],
    ['1.008', 'DPT_UpDown', ''],
    ['2.001', 'DPT_Switch_Control', ''],
    ['3.007', 'DPT_Control_Dimming', ''],
    ['5.001', 'DPT_Scaling', ' %'],
    ['5.010', 'DPT_Value_1_Ucount', ''],
    ['6.001', 'DPT_Percent_V8', ' %'],
    ['7.001', 'DPT_Value_2_Ucount', ''],
    ['8.001', 'DPT_Value_2_Count', ''],
    ['9.001', 'DPT_Value_Temp', ' °C'],
    ['9.007', 'DPT_Value_Humidity', ' %'],
    ['10.001', 'DPT_TimeOfDay', ''],
    ['11.001', 'DPT_Date', ''],
    ['12.001', 'DPT_Value_4_Ucount', ''],
    ['13.001', 'DPT_Value_4_Count', ''],
    ['14.056', 'DPT_Value_Power', ' W'],
    ['14.068', 'DPT_Value_Temperature', ' °C'],
    ['16.000', 'DPT_String_ASCII', ''],
    ['17.001', 'DPT_SceneNumber', ''],
    ['18.001', 'DPT_SceneControl', ''],
    ['19.001', 'DPT_DateTime', ''],
    ['20.102', 'DPT_HVACContrMode', ''],
    ['232.600', 'DPT_Colour_RGB', ''],
  ];

  for (const [dpt, name, unit] of checks) {
    it(`${dpt} → ${name}`, () => {
      const info = dptInfo(dpt);
      assert.equal(info.name, name);
      assert.equal(info.unit, unit);
    });
  }
});
