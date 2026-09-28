/**
 * Tests for server/ets-app.ts's resolveCoRef()/resolveCoRefById() capturing
 * ReadOnInitFlag and Priority, needed for Object 3 (Group Object Table)
 * support (docs/knx-device-write-protocol.md §10.1, knx-tables.ts's
 * GroupObjectFlags).
 *
 * Attribute names/values match real app XML: ReadOnInitFlag uses the same
 * Enabled/Disabled vocabulary as the other flags; Priority is
 * "Low"/"Alarm"/"High"/"System" (System is unreachable from ETS's own UI, so
 * real projects only ever show Low/Alarm/High - still covered here for
 * completeness of the normalization).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAppIndex } from '../server/ets-app.ts';

function appXml(
  appId: string,
  comObjectsXml: string,
  comObjectRefsXml: string,
): string {
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
  it('resolveCoRef(): ReadOnInitFlag="Disabled", no Priority attribute -> readOnInit=false, priority defaults "low"', () => {
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

  it('resolveCoRef(): a ComObjectRef-level Priority/ReadOnInitFlag overrides the ComObject default', () => {
    const xml = appXml(
      'AP-3',
      '<ComObject Id="AP-3_O-32" Number="32" Text="t" ObjectSize="1 Bit" ReadFlag="Enabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Enabled" ReadOnInitFlag="Disabled" Priority="Low" DatapointType="DPST-1-1" />',
      '<ComObjectRef Id="AP-3_O-32_R-1" RefId="AP-3_O-32" Priority="High" ReadOnInitFlag="Enabled" />',
    );
    const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
    assert(idx, 'buildAppIndex should parse the synthetic app XML');
    const resolved = idx!.resolveCoRef('O-32_R-1', '');
    assert(resolved, 'O-32_R-1 should resolve');
    assert.equal(
      resolved!.readOnInit,
      true,
      'ComObjectRef override should win over the ComObject default',
    );
    assert.equal(
      resolved!.priority,
      'high',
      'ComObjectRef override should win over the ComObject default',
    );
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
