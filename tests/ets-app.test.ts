/**
 * Tests for server/ets-app.ts's buildAppIndex()/buildParamModel() — in
 * particular the Union <Memory BitOffset> propagation bug (fix #3, patch 3).
 *
 * A <Union> element's bit position within its byte comes from the Union's
 * OWN <Memory BitOffset> child (its child Parameters conventionally carry
 * BitOffset="0"). Before the fix, addParam() only read the Union Memory's
 * Offset (byte position) and ignored its BitOffset, so a sub-byte Union
 * field landed in the wrong nibble — e.g. the MDT UP-2124/2125/2126
 * "BehaviourAtLocking_*" fields (real product XML:
 * `<Union SizeInBit="4"><Memory Offset="29" BitOffset="4"/>
 *  <Parameter … Offset="0" BitOffset="0"/></Union>`) were written to the
 * HIGH nibble (bitOffset 0) instead of the LOW nibble (bitOffset 4),
 * producing 0x20 where ETS wrote 0x22.
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
    // Pre-fix this was 0 (only the child Parameter's own BitOffset="0" was
    // used) — writeBits(29, bitOff=0, size=4, 2) sets the HIGH nibble (0x20).
    // Post-fix it must be 4 (the Union Memory's BitOffset), which sets the
    // LOW nibble — matching ETS.
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
    // The Union carries its byte Offset as a direct attribute (29) but its bit
    // position only in the <Memory BitOffset="4"> child. The BitOffset must
    // still be picked up — otherwise the 4-bit field lands in the wrong nibble.
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

// TypeRawData ParameterTypes (whole pre-baked binary blobs, e.g.
// "Characteristic curve value domain" tables) were never handled at all —
// every branch in the ParameterType-parsing loop checks for a specific
// child element (TypeNumber/TypeFloat/TypeTime/TypeText) before falling
// through to a generic TypeRestriction-based branch that only reads
// TypeRestriction's own SizeInBit. TypeRawData has none of those, so it
// silently got the `|| 8` fallback (1 byte) regardless of its real,
// potentially-hundreds-of-bytes size. Confirmed 2026-08-28 against a real
// device + its real .knxproj XML (`<TypeRawData MaxSize="516" />` for a
// 512-byte curve table) — root cause of a real, large gap between
// koolenex's computed parameter image and a real device. See
// docs/knx-device-write-protocol.md Part 9 and
// docs/follow-ups/2026-08-28-full-download-history-and-blob-params.md.
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
    // 516 bytes = 4128 bits — MaxSize is in bytes, confirmed against the
    // real device's own real .knxprod (MaxSize="516" for a real 512-byte
    // table + 4-byte length prefix = 516).
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
  // Real, only-ever-seen-once-so-far data point: HDL's app
  // (M-0073_A-20A9-10-EAA5) declares exactly one LdCtrlWriteRelMem, for
  // objIdx 4, with Verify="true" - the only occurrence of that attribute
  // anywhere in the app. See knx-connection.ts's own use of this field for
  // the full, deliberately cautious caveat on what it's believed to mean.
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
