/**
 * The hardware type an application expects its device to report
 * (PID_HARDWARE_TYPE of the device object), taken from the application's own
 * hidden "hardware type" parameter, and the parsing that finds it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHardwareTypeEnumText,
  getExpectedHardwareType,
  describeHardwareType,
  type HardwareTypeParamDef,
} from '../server/hardware-type.ts';
import { buildAppIndex } from '../server/ets-app.ts';

const APP = 'M-0004_A-D164-21-815F-O000A';
const DEFS: HardwareTypeParamDef[] = [
  {
    key: `${APP}_P-2`,
    value: '1',
    enums: {
      '1': '$00 0A 80 00 01 1D (KRMTSD F50 2-gang)',
      '2': '$00 0A 80 00 01 1E (KRMTSD F50 4-gang)',
    },
  },
];

describe('parseHardwareTypeEnumText', () => {
  it('reads the hex and the trailing description', () => {
    const r = parseHardwareTypeEnumText('$00 0A 80 00 01 10 (2-gang F50)')!;
    assert.equal(r.buffer.toString('hex'), '000a80000110');
    assert.equal(r.label, '2-gang F50');
  });

  it('accepts an option with no description', () => {
    const r = parseHardwareTypeEnumText('$00 0A 80 00 00 90')!;
    assert.equal(r.buffer.toString('hex'), '000a80000090');
    assert.equal(r.label, null);
  });

  it('rejects text that is not hex', () => {
    assert.equal(parseHardwareTypeEnumText('not a hardware type'), null);
  });
});

describe('getExpectedHardwareType', () => {
  it('uses the application default when the device stores no value', () => {
    const hw = getExpectedHardwareType(DEFS, {}, APP)!;
    assert.equal(hw.buffer.toString('hex'), '000a8000011d');
    assert.equal(hw.label, 'KRMTSD F50 2-gang');
  });

  it("uses the device's own stored value over the default", () => {
    const hw = getExpectedHardwareType(DEFS, { [`${APP}_P-2`]: '2' }, APP)!;
    assert.equal(hw.buffer.toString('hex'), '000a8000011e');
  });

  it('finds a value stored under a module-instance key (the parameter sits in a module)', () => {
    const hw = getExpectedHardwareType(
      DEFS,
      { [`${APP}_MD-1_M-254_MI-1_P-2_R-2`]: '2' },
      APP,
    )!;
    assert.equal(hw.buffer.toString('hex'), '000a8000011e');
    assert.equal(hw.label, 'KRMTSD F50 4-gang');
  });

  it('does not confuse a different parameter number', () => {
    const hw = getExpectedHardwareType(
      DEFS,
      { [`${APP}_MD-1_M-254_MI-1_P-22_R-2`]: '2' },
      APP,
    )!;
    assert.equal(
      hw.buffer.toString('hex'),
      '000a8000011d',
      'falls back to the default',
    );
  });

  it('is null when the application declares no hardware type', () => {
    assert.equal(getExpectedHardwareType(undefined, {}, APP), null);
    assert.equal(getExpectedHardwareType([], {}, APP), null);
  });
});

describe('describeHardwareType', () => {
  it('names the option matching the reported bytes, from the same application only', () => {
    assert.equal(
      describeHardwareType(DEFS, Buffer.from('000a8000011e', 'hex')),
      'KRMTSD F50 4-gang',
    );
    assert.equal(
      describeHardwareType(DEFS, Buffer.from('000a80000999', 'hex')),
      null,
    );
    assert.equal(
      describeHardwareType(undefined, Buffer.from('000a8000011e', 'hex')),
      null,
    );
  });
});

describe('buildAppIndex - hardware type parameter', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX><ManufacturerData><Manufacturer><ApplicationPrograms>
  <ApplicationProgram Id="AP-HW">
    <Static>
      <ParameterTypes>
        <ParameterType Id="AP-HW_PT-HwType" Name="HwType">
          <TypeRestriction Base="Value" SizeInBit="8">
            <Enumeration Text="$00 0A 80 00 01 1D (2-gang)" Value="1" Id="AP-HW_PT-HwType_EN-1" DisplayOrder="0" />
            <Enumeration Text="$00 0A 80 00 01 1E (4-gang)" Value="2" Id="AP-HW_PT-HwType_EN-2" DisplayOrder="1" />
          </TypeRestriction>
        </ParameterType>
        <ParameterType Id="AP-HW_PT-Other" Name="Other">
          <TypeRestriction Base="Value" SizeInBit="8">
            <Enumeration Text="a" Value="0" Id="AP-HW_PT-Other_EN-0" DisplayOrder="0" />
          </TypeRestriction>
        </ParameterType>
      </ParameterTypes>
      <Parameters>
        <Parameter Id="AP-HW_P-2" Name="_Allg_Hardware_Type" ParameterType="AP-HW_PT-HwType" Access="None" Value="2">
          <Property ObjectIndex="0" PropertyId="78" Offset="0" BitOffset="0" />
        </Parameter>
        <Parameter Id="AP-HW_P-3" Name="Other" ParameterType="AP-HW_PT-Other" Value="0">
          <Property ObjectIndex="0" PropertyId="52" Offset="0" BitOffset="0" />
        </Parameter>
        <Parameter Id="AP-HW_P-4" Name="Plain" ParameterType="AP-HW_PT-Other" Value="0">
          <Memory CodeSegment="AP-HW_RS-04-00000" Offset="0" BitOffset="0" />
        </Parameter>
      </Parameters>
      <LoadProcedures />
    </Static>
  </ApplicationProgram>
</ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

  it('picks out only the device-object property 78 parameter, with its enumeration and default', () => {
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'))!;
    assert.equal(idx.hardwareTypeParams.length, 1);
    const p = idx.hardwareTypeParams[0]!;
    assert.equal(p.key, 'AP-HW_P-2');
    assert.equal(p.value, '2');
    assert.deepEqual(Object.keys(p.enums), ['1', '2']);
    const hw = getExpectedHardwareType(idx.hardwareTypeParams, {}, 'AP-HW')!;
    assert.equal(hw.buffer.toString('hex'), '000a8000011e');
    assert.equal(hw.label, '4-gang');
  });

  it('reports no hardware type parameter for an application that declares none', () => {
    const none = xml.replace(
      /<Property ObjectIndex="0" PropertyId="78"[^>]*\/>/,
      '',
    );
    const idx = buildAppIndex(Buffer.from(none, 'utf8'))!;
    assert.deepEqual(idx.hardwareTypeParams, []);
  });
});
