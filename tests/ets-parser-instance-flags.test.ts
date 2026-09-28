/**
 * A device's ComObjectInstanceRef can override the application's comm-object
 * flags for that one instance: ReadFlag, WriteFlag, CommunicationFlag,
 * TransmitFlag, UpdateFlag, ReadOnInitFlag and Priority. An explicit override
 * must win over whatever the application declares - ignoring one writes the
 * wrong bit into Object 3's flag byte - and a flag the instance does not set
 * keeps its application-level value.
 *
 * Fixtures are minimal, real-shaped .knxproj zips built with the same zip
 * library parseKnxproj() reads with. No application XML is supplied, so every
 * flag starts at its bare false default and the tests isolate the
 * instance-level override itself.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rawMinizipCtor } from '../server/minizip.ts';
import { parseKnxproj } from '../server/ets-parser.ts';

interface MinizipWriteInstance {
  append(path: string, data: Buffer, opts?: { password?: string }): void;
  zip(): Uint8Array;
}
const Minizip = rawMinizipCtor as new () => MinizipWriteInstance;

/** Real `.knxproj` zip layout: `P-<id>/0.xml` (installation data) +
 *  `P-<id>/project.xml` (project metadata) - see `parseKnxproj()`'s own
 *  `installEntries`/`projKey` derivation (`entry.entryName.replace('0.xml',
 *  'project.xml')`) for why these two exact paths matter. */
function buildKnxprojZip(
  xml0: string,
  projectXml: string,
  projectId = 'P-0001',
): Buffer {
  const mz = new Minizip();
  mz.append(`${projectId}/0.xml`, Buffer.from(xml0, 'utf8'));
  mz.append(`${projectId}/project.xml`, Buffer.from(projectXml, 'utf8'));
  return Buffer.from(mz.zip());
}

const XMLNS = 'http://knx.org/xml/project/23';

function projectXml(
  opts: { groupAddressStyle?: string; guid?: string } = {},
): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="${XMLNS}">
  <Project Id="P-0001">
    <ProjectInformation Name="Test Project" GroupAddressStyle="${opts.groupAddressStyle ?? 'ThreeLevel'}" Guid="${opts.guid ?? '00000000-0000-0000-0000-000000000000'}" />
  </Project>
</KNX>`;
}

/** Real, minimal ThreeLevel GroupAddresses block - flat Address values are
 *  the real `(main<<11)|(middle<<8)|sub` packing (`ets-parser.ts:707-711`,
 *  confirmed against `knx-cemi.ts`'s own encode/decode). */
function threeLevelGroupAddresses(): string {
  return `<GroupAddresses>
      <GroupRanges>
        <GroupRange Name="Main">
          <GroupRange Name="Middle">
            <GroupAddress Id="GA-1" Address="2305" Name="Test GA" DatapointType="DPST-1-1" />
          </GroupRange>
        </GroupRange>
      </GroupRanges>
    </GroupAddresses>`;
}

describe('parseKnxproj() - ComObjectInstanceRef flag overrides', () => {
  it('a real instance-level ReadFlag="Enabled" override is applied (real device shape)', () => {
    const xml0 = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="${XMLNS}">
  <Project Id="P-0001">
    <Installations>
      <Installation Name="Test">
        <Topology>
          <Area Address="1" Name="Area 1">
            <Line Address="1" Name="Line 1">
              <Segment Number="0" MediumTypeRefId="MT-0" Name="TP Segment">
                <DeviceInstance Id="DI-1" Address="42" Name="Test Device">
                  <ComObjectInstanceRefs>
                    <ComObjectInstanceRef RefId="O-3_R-86" ReadFlag="Enabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Enabled" />
                  </ComObjectInstanceRefs>
                </DeviceInstance>
              </Segment>
            </Line>
          </Area>
        </Topology>
      </Installation>
    </Installations>
  </Project>
</KNX>`;
    const buf = buildKnxprojZip(xml0, projectXml());
    const parsed = parseKnxproj(buf, null);
    const co = parsed.comObjects.find((c) => c.device_address === '1.1.42');
    assert.ok(co, 'expected a comObject for device 1.1.42');
    assert.equal(co!.read, true);
    assert.equal(co!.write, true);
    assert.equal(co!.comm, true);
    assert.equal(co!.tx, true);
    assert.equal(co!.update, true);
  });

  it('with NO instance-level flags declared, flags stay at their base (false, since no app XML resolves them in this fixture)', () => {
    const xml0 = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="${XMLNS}">
  <Project Id="P-0001">
    <Installations>
      <Installation Name="Test">
        <Topology>
          <Area Address="1" Name="Area 1">
            <Line Address="1" Name="Line 1">
              <Segment Number="0" MediumTypeRefId="MT-0" Name="TP Segment">
                <DeviceInstance Id="DI-1" Address="43" Name="Test Device">
                  <ComObjectInstanceRefs>
                    <ComObjectInstanceRef RefId="O-3_R-86" />
                  </ComObjectInstanceRefs>
                </DeviceInstance>
              </Segment>
            </Line>
          </Area>
        </Topology>
      </Installation>
    </Installations>
  </Project>
</KNX>`;
    const buf = buildKnxprojZip(xml0, projectXml());
    const parsed = parseKnxproj(buf, null);
    const co = parsed.comObjects.find((c) => c.device_address === '1.1.43');
    assert.ok(co);
    assert.equal(co!.read, false);
    assert.equal(co!.write, false);
  });

  it('an instance-level ReadOnInitFlag/Priority override still works', () => {
    const xml0 = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="${XMLNS}">
  <Project Id="P-0001">
    <Installations>
      <Installation Name="Test">
        <Topology>
          <Area Address="1" Name="Area 1">
            <Line Address="1" Name="Line 1">
              <Segment Number="0" MediumTypeRefId="MT-0" Name="TP Segment">
                <DeviceInstance Id="DI-1" Address="44" Name="Test Device">
                  <ComObjectInstanceRefs>
                    <ComObjectInstanceRef RefId="O-3_R-86" ReadOnInitFlag="Enabled" Priority="high" />
                  </ComObjectInstanceRefs>
                </DeviceInstance>
              </Segment>
            </Line>
          </Area>
        </Topology>
      </Installation>
    </Installations>
  </Project>
</KNX>`;
    const buf = buildKnxprojZip(xml0, projectXml());
    const parsed = parseKnxproj(buf, null);
    const co = parsed.comObjects.find((c) => c.device_address === '1.1.44');
    assert.ok(co);
    assert.equal(co!.read_on_init, true);
    assert.equal(co!.priority, 'high');
  });
});
