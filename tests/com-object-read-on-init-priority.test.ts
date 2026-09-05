/**
 * Tests for server/ets-app.ts's resolveCoRef()/resolveCoRefById() capturing
 * ReadOnInitFlag and Priority - added 2026-08-29 for Object 3 (Group Object
 * Table) support (docs/knx-device-write-protocol.md §10.1, knx-tables.ts's
 * GroupObjectFlags). Neither attribute was extracted anywhere in the parser
 * before this - a real, separate gap found while wiring Object 3's write
 * trigger into downloadDevice() (see docs/follow-ups/2026-08-29-partial-
 * download-mode-and-obj3-trigger-test.md Part 12).
 *
 * Attribute names/values below are transcribed directly from this project's
 * own real app XML (M-0004_A-0025-10-1BA6-O00A6.xml / M-0004_A-3030-23-F0EA-
 * O000A.xml, extracted from the live Test Bed .knxproj) - ReadOnInitFlag
 * uses the same Enabled/Disabled vocabulary as the other flags; Priority is
 * "Low"/"Alarm"/"High"/"System" (System confirmed unreachable from ETS's own
 * UI per the reference doc, so real projects only ever show Low/Alarm/High -
 * still included here for completeness of the normalization).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAppIndex } from '../server/ets-app.ts';

function appXml(appId: string, comObjectsXml: string, comObjectRefsXml: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer>
      <ApplicationPrograms>
        <ApplicationProgram Id="${appId}">
          <Static>
            <ComObjects>
              ${comObjectsXml}
            </ComObjects>
            <ComObjectRefs>
              ${comObjectRefsXml}
            </ComObjectRefs>
          </Static>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;
}

describe('ets-app.ts: ComObject/ComObjectRef ReadOnInitFlag + Priority', () => {
  it('resolveCoRef(): ReadOnInitFlag="Disabled", no Priority attribute -> readOnInit=false, priority defaults "low" (real 1.1.9 shape)', () => {
    const xml = appXml(
      'AP-1',
      '<ComObject Id="AP-1_O-6" Number="6" Text="t" ObjectSize="1 Byte" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" DatapointType="DPST-5-1" />',
      '<ComObjectRef Id="AP-1_O-6_R-1" RefId="AP-1_O-6" />',
    );
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const resolved = idx!.resolveCoRef('O-6_R-1', '');
    assert(resolved, 'O-6_R-1 should resolve');
    assert.equal(resolved!.readOnInit, false);
    assert.equal(resolved!.priority, 'low');
  });

  it('resolveCoRef(): ReadOnInitFlag="Enabled", Priority="Alarm" on the ComObject -> both picked up', () => {
    const xml = appXml(
      'AP-2',
      '<ComObject Id="AP-2_O-7" Number="7" Text="t" ObjectSize="1 Byte" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Enabled" Priority="Alarm" DatapointType="DPST-5-1" />',
      '<ComObjectRef Id="AP-2_O-7_R-1" RefId="AP-2_O-7" />',
    );
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const resolved = idx!.resolveCoRef('O-7_R-1', '');
    assert(resolved, 'O-7_R-1 should resolve');
    assert.equal(resolved!.readOnInit, true);
    assert.equal(resolved!.priority, 'alarm');
  });

  it('resolveCoRef(): a ComObjectRef-level Priority/ReadOnInitFlag overrides the ComObject default (real 1.1.10 shape - per-instance overrides)', () => {
    const xml = appXml(
      'AP-3',
      '<ComObject Id="AP-3_O-32" Number="32" Text="t" ObjectSize="1 Bit" ReadFlag="Enabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Enabled" ReadOnInitFlag="Disabled" Priority="Low" DatapointType="DPST-1-1" />',
      '<ComObjectRef Id="AP-3_O-32_R-1" RefId="AP-3_O-32" Priority="High" ReadOnInitFlag="Enabled" />',
    );
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const resolved = idx!.resolveCoRef('O-32_R-1', '');
    assert(resolved, 'O-32_R-1 should resolve');
    assert.equal(resolved!.readOnInit, true, 'ComObjectRef override should win over the ComObject default');
    assert.equal(resolved!.priority, 'high', 'ComObjectRef override should win over the ComObject default');
  });

  it('resolveCoRef(): Priority="System" normalizes to "system" (confirmed unreachable from ETS itself, but the parser should still round-trip it faithfully if present)', () => {
    const xml = appXml(
      'AP-4',
      '<ComObject Id="AP-4_O-1" Number="1" Text="t" ObjectSize="1 Bit" ReadFlag="Enabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" Priority="System" DatapointType="DPST-1-1" />',
      '<ComObjectRef Id="AP-4_O-1_R-1" RefId="AP-4_O-1" />',
    );
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const resolved = idx!.resolveCoRef('O-1_R-1', '');
    assert(resolved, 'O-1_R-1 should resolve');
    assert.equal(resolved!.priority, 'system');
  });

  it('resolveCoRefById(): same ReadOnInitFlag/Priority resolution as resolveCoRef() (used for active-but-unlinked COM objects)', () => {
    const xml = appXml(
      'AP-5',
      '<ComObject Id="AP-5_O-96" Number="96" Text="t" ObjectSize="1 Byte" ReadFlag="Enabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Enabled" ReadOnInitFlag="Disabled" Priority="Low" DatapointType="DPST-5-1" />',
      '<ComObjectRef Id="AP-5_O-96_R-1" RefId="AP-5_O-96" Priority="Alarm" ReadOnInitFlag="Enabled" />',
    );
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const resolved = idx!.resolveCoRefById('AP-5_O-96_R-1');
    assert(resolved, 'AP-5_O-96_R-1 should resolve');
    assert.equal(resolved!.readOnInit, true);
    assert.equal(resolved!.priority, 'alarm');
  });
});
