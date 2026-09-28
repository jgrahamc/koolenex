/**
 * Tests for server/ets-app.ts's buildAppIndex()/buildParamModel().
 *
 * A <Union> element's bit position within its byte comes from the Union's
 * OWN <Memory BitOffset> child (child Parameters conventionally carry
 * BitOffset="0"). addParam() must fold this into the child param's
 * bitOffset, not just the Union Memory's byte Offset — otherwise a sub-byte
 * Union field lands in the wrong nibble.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAppIndex } from '../server/ets-app.ts';

// Minimal synthetic ETS6 application-program XML exercising exactly the
// Union/Memory/Parameter path addParam() walks — no .knxproj, no DB.
const UNION_APP_XML = `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer>
      <ApplicationPrograms>
        <ApplicationProgram Id="AP-1">
          <Static>
            <ParameterTypes>
              <ParameterType Id="PT-1">
                <TypeNumber SizeInBit="4" />
              </ParameterType>
            </ParameterTypes>
            <Parameters>
              <Union SizeInBit="4">
                <Memory Offset="29" BitOffset="4" />
                <Parameter Id="P-1" ParameterType="PT-1" Value="2" Text="Union field" Offset="0" BitOffset="0" />
              </Union>
            </Parameters>
            <ParameterRefs>
              <ParameterRef Id="PR-1" RefId="P-1" />
            </ParameterRefs>
          </Static>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;

describe('ets-app.ts: Union <Memory BitOffset> propagation', () => {
  it('folds the Union Memory BitOffset into the child param bitOffset', () => {
    const idx = buildAppIndex(Buffer.from(UNION_APP_XML, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const model = idx!.buildParamModel();
    const entry = model.paramMemLayout['PR-1'];
    assert(entry, 'PR-1 should be present in paramMemLayout');
    assert.equal(
      entry.offset,
      29,
      'byte offset should come from the Union Memory Offset',
    );
    // Must be 4 (the Union Memory's BitOffset), which sets the LOW nibble;
    // using the child Parameter's own BitOffset="0" would set the HIGH one.
    assert.equal(entry.bitOffset, 4);
    assert.equal(entry.bitSize, 4);
  });

  it('does not affect standalone (non-Union) params: no baseBitOffset applied', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer>
      <ApplicationPrograms>
        <ApplicationProgram Id="AP-2">
          <Static>
            <ParameterTypes>
              <ParameterType Id="PT-2">
                <TypeNumber SizeInBit="8" />
              </ParameterType>
            </ParameterTypes>
            <Parameters>
              <Parameter Id="P-2" ParameterType="PT-2" Value="5" Text="Plain param">
                <Memory Offset="10" BitOffset="0" />
              </Parameter>
            </Parameters>
            <ParameterRefs>
              <ParameterRef Id="PR-2" RefId="P-2" />
            </ParameterRefs>
          </Static>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const model = idx!.buildParamModel();
    const entry = model.paramMemLayout['PR-2'];
    assert(entry, 'PR-2 should be present in paramMemLayout');
    assert.equal(entry.offset, 10);
    assert.equal(entry.bitOffset, 0);
  });

  it('honors a Union <Memory BitOffset> even when the byte Offset is a direct Union attribute', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer>
      <ApplicationPrograms>
        <ApplicationProgram Id="AP-3">
          <Static>
            <ParameterTypes>
              <ParameterType Id="PT-3">
                <TypeNumber SizeInBit="4" />
              </ParameterType>
            </ParameterTypes>
            <Parameters>
              <Union SizeInBit="4" Offset="29">
                <Memory BitOffset="4" />
                <Parameter Id="P-3" ParameterType="PT-3" Value="2" Text="Union field" Offset="0" BitOffset="0" />
              </Union>
            </Parameters>
            <ParameterRefs>
              <ParameterRef Id="PR-3" RefId="P-3" />
            </ParameterRefs>
          </Static>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const model = idx!.buildParamModel();
    const entry = model.paramMemLayout['PR-3'];
    assert(entry, 'PR-3 should be present in paramMemLayout');
    assert.equal(entry.offset, 29);
    assert.equal(entry.bitOffset, 4);
  });
});

// TypeRawData ParameterTypes are pre-baked binary blobs (e.g. "Characteristic
// curve value domain" tables). Unlike TypeNumber/TypeFloat/TypeTime/TypeText,
// size is MaxSize (bytes, not bits) on TypeRawData itself, not via
// TypeRestriction's SizeInBit. See docs/knx-device-write-protocol.md Part 9.
describe('ets-app.ts: TypeRawData ParameterType (blob-shaped defaults)', () => {
  it('reads MaxSize into bitSize (bytes, not bits) instead of falling back to 8', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer>
      <ApplicationPrograms>
        <ApplicationProgram Id="AP-4">
          <Static>
            <ParameterTypes>
              <ParameterType Id="PT-4">
                <TypeRawData MaxSize="516" />
              </ParameterType>
            </ParameterTypes>
            <Parameters>
              <Parameter Id="P-4" ParameterType="PT-4" Value="AAAAAQIDBA==" Text="Curve" Access="None" Offset="0" BitOffset="0" />
            </Parameters>
            <ParameterRefs>
              <ParameterRef Id="PR-4" RefId="P-4" />
            </ParameterRefs>
          </Static>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const model = idx!.buildParamModel();
    const entry = model.paramMemLayout['PR-4'];
    assert(entry, 'PR-4 should be present in paramMemLayout');
    // 516 bytes = 4128 bits — MaxSize is in bytes.
    assert.equal(entry.bitSize, 4128);
    assert.equal(entry.defaultValue, 'AAAAAQIDBA==');
  });

  it('falls back to 1 byte (not a crash) when MaxSize is missing', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer>
      <ApplicationPrograms>
        <ApplicationProgram Id="AP-5">
          <Static>
            <ParameterTypes>
              <ParameterType Id="PT-5">
                <TypeRawData />
              </ParameterType>
            </ParameterTypes>
            <Parameters>
              <Parameter Id="P-5" ParameterType="PT-5" Value="AA==" Text="Curve" Access="None" Offset="0" BitOffset="0" />
            </Parameters>
            <ParameterRefs>
              <ParameterRef Id="PR-5" RefId="P-5" />
            </ParameterRefs>
          </Static>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const model = idx!.buildParamModel();
    const entry = model.paramMemLayout['PR-5'];
    assert(entry, 'PR-5 should be present in paramMemLayout');
    assert.equal(entry.bitSize, 8);
  });
});

describe('ets-app.ts: LdCtrlWriteRelMem Verify attribute', () => {
  it('parses Verify="true" into the WriteRelMem step', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer>
      <ApplicationPrograms>
        <ApplicationProgram Id="AP-6">
          <Static>
            <LoadProcedures>
              <LoadProcedure MergeId="4">
                <LdCtrlWriteRelMem ObjIdx="4" Offset="0" Size="152" Verify="true" AppliesTo="full,par" />
              </LoadProcedure>
            </LoadProcedures>
          </Static>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const step = idx!.loadProcedures.find((s) => s.type === 'WriteRelMem');
    assert(step, 'a WriteRelMem step should be present');
    assert.equal(step!.verify, true);
  });

  it('parses a missing Verify attribute as false, not undefined/truthy', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer>
      <ApplicationPrograms>
        <ApplicationProgram Id="AP-7">
          <Static>
            <LoadProcedures>
              <LoadProcedure MergeId="4">
                <LdCtrlWriteRelMem ObjIdx="4" Offset="0" Size="8" AppliesTo="full" />
              </LoadProcedure>
            </LoadProcedures>
          </Static>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const step = idx!.loadProcedures.find((s) => s.type === 'WriteRelMem');
    assert(step, 'a WriteRelMem step should be present');
    assert.equal(step!.verify, false);
  });
});

describe('buildAppIndex - StartElement, Count and PeiType', () => {
  const app = (
    attrs: string,
    steps: string,
  ) => `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer>
      <ApplicationPrograms>
        <ApplicationProgram Id="AP-9" ${attrs}>
          <Static>
            <LoadProcedures>
              <LoadProcedure MergeId="4">
                ${steps}
              </LoadProcedure>
            </LoadProcedures>
          </Static>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;

  it('parses PeiType from the ApplicationProgram, undefined when absent', () => {
    const withPei = buildAppIndex(
      Buffer.from(app('PeiType="0"', '<LdCtrlConnect />'), 'utf8'),
    );
    const without = buildAppIndex(
      Buffer.from(app('', '<LdCtrlConnect />'), 'utf8'),
    );
    assert.equal(withPei!.peiType, '0');
    assert.equal(without!.peiType, undefined);
  });
});

describe('buildAppIndex - Verify on LdCtrlWriteProp and LdCtrlWriteRelMem', () => {
  const app = (steps: string) => `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer>
      <ApplicationPrograms>
        <ApplicationProgram Id="AP-10">
          <Static>
            <LoadProcedures>
              <LoadProcedure MergeId="4">
                ${steps}
              </LoadProcedure>
            </LoadProcedures>
          </Static>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;

  it('records an explicit Verify true/false as verifyResponse, and leaves it absent when not declared', () => {
    const idx = buildAppIndex(
      Buffer.from(
        app(
          '<LdCtrlWriteProp ObjIdx="4" PropId="27" Verify="false" InlineData="0000000A00330000" />' +
            '<LdCtrlWriteProp ObjIdx="4" PropId="13" Verify="true" InlineData="0000000000" />' +
            '<LdCtrlWriteProp ObjIdx="4" PropId="14" InlineData="00" />' +
            '<LdCtrlWriteRelMem ObjIdx="4" Offset="0" Size="8" Verify="false" AppliesTo="full" />' +
            '<LdCtrlWriteRelMem ObjIdx="3" Offset="0" Size="8" AppliesTo="full" />',
        ),
        'utf8',
      ),
    );
    const props = idx!.loadProcedures.filter(
      (s) => s.type === 'WriteProp',
    ) as Array<{ verifyResponse?: boolean }>;
    assert.equal(props[0]!.verifyResponse, false);
    assert.equal(props[1]!.verifyResponse, true);
    assert.equal(props[2]!.verifyResponse, undefined);
    const mems = idx!.loadProcedures.filter(
      (s) => s.type === 'WriteRelMem',
    ) as Array<{ verifyResponse?: boolean }>;
    assert.equal(mems[0]!.verifyResponse, false);
    assert.equal(mems[1]!.verifyResponse, undefined);
  });
});

describe('buildAppIndex - unrecognised LdCtrl steps and LineCoupler0912NewProgrammingStyle', () => {
  const app = (
    options: string,
    steps: string,
  ) => `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer>
      <ApplicationPrograms>
        <ApplicationProgram Id="AP-11">
          <Static>
            ${options}
            <LoadProcedures>
              <LoadProcedure MergeId="4">
                ${steps}
              </LoadProcedure>
            </LoadProcedures>
          </Static>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;

  it('keeps an unrecognised LdCtrl* step as Unhandled instead of dropping it', () => {
    const idx = buildAppIndex(
      Buffer.from(
        app('', '<LdCtrlConnect /><LdCtrlWriteMem Address="256" Size="2" />'),
        'utf8',
      ),
    );
    const un = idx!.loadProcedures.filter(
      (s) => s.type === 'Unhandled',
    ) as Array<{ tag: string }>;
    assert.equal(un.length, 1);
    assert.equal(un[0]!.tag, 'LdCtrlWriteMem');
  });

  it('parses LineCoupler0912NewProgrammingStyle true/false, undefined when absent', () => {
    const t = buildAppIndex(
      Buffer.from(
        app(
          '<Options LineCoupler0912NewProgrammingStyle="true"/>',
          '<LdCtrlConnect />',
        ),
        'utf8',
      ),
    );
    const f = buildAppIndex(
      Buffer.from(
        app(
          '<Options LineCoupler0912NewProgrammingStyle="false"/>',
          '<LdCtrlConnect />',
        ),
        'utf8',
      ),
    );
    const n = buildAppIndex(Buffer.from(app('', '<LdCtrlConnect />'), 'utf8'));
    assert.equal(t!.lineCoupler0912NewProgrammingStyle, true);
    assert.equal(f!.lineCoupler0912NewProgrammingStyle, false);
    assert.equal(n!.lineCoupler0912NewProgrammingStyle, undefined);
  });
});

describe('buildAppIndex - AbsSegment Access, MemType, SegType and SegFlags', () => {
  it('parses the four attributes when declared, leaves them absent otherwise', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX><ManufacturerData><Manufacturer><ApplicationPrograms>
  <ApplicationProgram Id="AP-12"><Static><LoadProcedures>
    <LoadProcedure MergeId="4">
      <LdCtrlAbsSegment LsmIdx="1" Address="18710" Size="64" Access="3" MemType="2" SegType="0" SegFlags="0" />
      <LdCtrlAbsSegment LsmIdx="2" Address="1792" Size="8" />
    </LoadProcedure>
  </LoadProcedures></Static></ApplicationProgram>
</ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
    const segs = idx!.loadProcedures.filter(
      (s) => s.type === 'AbsSegment',
    ) as Array<Record<string, number | undefined>>;
    assert.equal(segs[0]!.segFlags, 0);
    assert.equal(segs[0]!.access, 3);
    assert.equal(segs[0]!.memType, 2);
    assert.equal(segs[0]!.segType, 0);
    assert.equal(segs[1]!.segFlags, undefined);
  });
});

describe('buildAppIndex - load procedure steps keep the order the application declares', () => {
  const app = (procedures: string) => `<?xml version="1.0" encoding="utf-8"?>
<KNX><ManufacturerData><Manufacturer><ApplicationPrograms>
  <ApplicationProgram Id="AP-13"><Static><LoadProcedures>
    ${procedures}
  </LoadProcedures></Static></ApplicationProgram>
</ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

  it('interleaves steps of different kinds in document order, not grouped by tag', () => {
    const idx = buildAppIndex(
      Buffer.from(
        app(`<LoadProcedure MergeId="4">
      <LdCtrlWriteProp ObjIdx="4" PropId="27" InlineData="0000000A00330000" />
      <LdCtrlLoadImageProp ObjIdx="4" PropId="27" Count="2" />
      <LdCtrlWriteProp ObjIdx="1" PropId="5" InlineData="00" />
      <LdCtrlCompareProp ObjIdx="4" PropId="13" InlineData="0102" />
    </LoadProcedure>`),
        'utf8',
      ),
    );
    assert.deepEqual(
      idx!.loadProcedures.map((s) => s.type),
      ['WriteProp', 'LoadImageProp', 'WriteProp', 'CompareProp'],
    );
    const writes = idx!.loadProcedures.filter(
      (s) => s.type === 'WriteProp',
    ) as Array<{ objIdx: number }>;
    assert.deepEqual(
      writes.map((w) => w.objIdx),
      [4, 1],
    );
  });

  it('keeps separate LoadProcedure blocks in sequence, each with its own MergeId', () => {
    const idx = buildAppIndex(
      Buffer.from(
        app(`<LoadProcedure MergeId="2">
      <LdCtrlLoadImageProp ObjIdx="1" PropId="27" />
      <LdCtrlWriteProp ObjIdx="1" PropId="5" InlineData="00" />
    </LoadProcedure>
    <LoadProcedure MergeId="4">
      <LdCtrlWriteProp ObjIdx="4" PropId="13" InlineData="00" />
      <LdCtrlLoadImageProp ObjIdx="4" PropId="27" />
    </LoadProcedure>`),
        'utf8',
      ),
    );
    assert.deepEqual(
      idx!.loadProcedures.map((s) => `${s.type}:${s.mergeId}`),
      ['LoadImageProp:2', 'WriteProp:2', 'WriteProp:4', 'LoadImageProp:4'],
    );
  });
});
