import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import {
  toArr,
  makeUpdateBuilder,
  getDptInfo,
  parseMasterXml,
  saveMasterXml,
  readMasterXml,
  saveModelsAndMasterXml,
  DATA_DIR,
  APPS_DIR,
} from '../server/routes/shared.ts';

const uid = `test_shared_${Date.now()}`;

// Track temp files/dirs for cleanup
const tempFiles: string[] = [];
const tempDirs: string[] = [];

after(() => {
  for (const f of tempFiles) {
    try {
      fs.unlinkSync(f);
    } catch (_) {}
  }
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true });
    } catch (_) {}
  }
});

// ── toArr ──────────────────────────────────────────────────────────────────────

describe('toArr', () => {
  it('null → []', () => {
    assert.deepEqual(toArr(null), []);
  });

  it('undefined → []', () => {
    assert.deepEqual(toArr(undefined), []);
  });

  it('single value → [value]', () => {
    assert.deepEqual(toArr(42), [42]);
  });

  it('array passes through unchanged', () => {
    const arr = [1, 2, 3];
    assert.equal(toArr(arr), arr);
  });

  it('empty array → []', () => {
    assert.deepEqual(toArr([]), []);
  });

  it('string → [string]', () => {
    assert.deepEqual(toArr('hello'), ['hello']);
  });
});

// ── makeUpdateBuilder ────────────────────────────────────────────────────────────────

describe('makeUpdateBuilder', () => {
  it('track() adds column=? to sets', () => {
    const { track, sets } = makeUpdateBuilder({ name: 'old' });
    track('name', 'new');
    assert.deepEqual(sets, ['name=?']);
  });

  it('track() pushes value to vals', () => {
    const { track, vals } = makeUpdateBuilder({ name: 'old' });
    track('name', 'new');
    assert.deepEqual(vals, ['new']);
  });

  it('track() records old→new diff string', () => {
    const { track, diffs } = makeUpdateBuilder({ name: 'old' });
    track('name', 'new');
    assert.equal(diffs.length, 1);
    assert.match(diffs[0], /name/);
    assert.match(diffs[0], /old/);
    assert.match(diffs[0], /new/);
  });

  it('multiple track() calls accumulate correctly', () => {
    const { track, sets, vals, diffs } = makeUpdateBuilder({ a: '1', b: '2' });
    track('a', '10');
    track('b', '20');
    assert.deepEqual(sets, ['a=?', 'b=?']);
    assert.deepEqual(vals, ['10', '20']);
    assert.equal(diffs.length, 2);
  });

  it('old values of undefined show as empty string in diffs', () => {
    const { track, diffs } = makeUpdateBuilder({});
    track('missing', 'val');
    assert.match(diffs[0], /"" →/);
  });
});

// ── parseMasterXml ─────────────────────────────────────────────────────────────

describe('parseMasterXml', () => {
  const minimalXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <MasterData>
    <DatapointTypes>
      <DatapointType Number="1" SizeInBit="1">
        <DatapointSubtypes>
          <DatapointSubtype Number="1" Name="DPT_Switch" Text="switch"/>
        </DatapointSubtypes>
      </DatapointType>
    </DatapointTypes>
  </MasterData>
</KNX>`;

  it('parses minimal KNX master XML with one DatapointType and one DatapointSubtype', () => {
    const root = parseMasterXml(minimalXml);
    const dptTypes = root.KNX.MasterData.DatapointTypes.DatapointType;
    assert.ok(Array.isArray(dptTypes));
    assert.equal(dptTypes.length, 1);
    const subs = dptTypes[0].DatapointSubtypes.DatapointSubtype;
    assert.ok(Array.isArray(subs));
    assert.equal(subs.length, 1);
  });

  it('returns nested structure with @_ prefixed attributes', () => {
    const root = parseMasterXml(minimalXml);
    const dpt = root.KNX.MasterData.DatapointTypes.DatapointType[0];
    assert.equal(dpt['@_Number'], '1');
    assert.equal(dpt['@_SizeInBit'], '1');
    const sub = dpt.DatapointSubtypes.DatapointSubtype[0];
    assert.equal(sub['@_Name'], 'DPT_Switch');
    assert.equal(sub['@_Text'], 'switch');
  });

  it('array wrapping works for configured element names', () => {
    const root = parseMasterXml(minimalXml);
    // DatapointType and DatapointSubtype are configured as isArray
    assert.ok(Array.isArray(root.KNX.MasterData.DatapointTypes.DatapointType));
    assert.ok(
      Array.isArray(
        root.KNX.MasterData.DatapointTypes.DatapointType[0].DatapointSubtypes
          .DatapointSubtype,
      ),
    );
  });
});

// ── getDptInfo ─────────────────────────────────────────────────────────────────

describe('getDptInfo', () => {
  const pid = `${uid}_dpt`;

  const realisticXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <MasterData>
    <DatapointTypes>
      <DatapointType Number="1" SizeInBit="1">
        <DatapointSubtypes>
          <DatapointSubtype Number="1" Name="DPT_Switch" Text="switch">
            <Format>
              <Bit Cleared="Off" Set="On"/>
            </Format>
          </DatapointSubtype>
        </DatapointSubtypes>
      </DatapointType>
      <DatapointType Number="5" SizeInBit="8">
        <DatapointSubtypes>
          <DatapointSubtype Number="1" Name="DPT_Scaling" Text="percentage (0..100%)">
            <Format>
              <UnsignedInteger Unit="%" Coefficient="0.4"/>
            </Format>
          </DatapointSubtype>
        </DatapointSubtypes>
      </DatapointType>
      <DatapointType Number="20" SizeInBit="8">
        <DatapointSubtypes>
          <DatapointSubtype Number="102" Name="DPT_HVACMode" Text="HVAC mode">
            <Format>
              <Enumeration>
                <EnumValue Value="0" Text="Auto"/>
                <EnumValue Value="1" Text="Comfort"/>
                <EnumValue Value="2" Text="Standby"/>
                <EnumValue Value="3" Text="Economy"/>
                <EnumValue Value="4" Text="Building Protection"/>
              </Enumeration>
            </Format>
          </DatapointSubtype>
        </DatapointSubtypes>
      </DatapointType>
    </DatapointTypes>
  </MasterData>
</KNX>`;

  // Write temp XML before tests run (synchronous, runs before it blocks)
  const xmlPath = path.join(DATA_DIR, `knx_master_${pid}.xml`);
  fs.writeFileSync(xmlPath, realisticXml);
  tempFiles.push(xmlPath);

  it('returns {} when no master XML exists for projectId', () => {
    const result = getDptInfo(`${uid}_nonexistent`);
    assert.deepEqual(result, {});
  });

  it('parses XML and returns correct key format (e.g. "1.001")', () => {
    const info = getDptInfo(pid);
    assert.ok('1.001' in info);
    assert.ok('5.001' in info);
    assert.ok('20.102' in info);
  });

  it('extracts name, text, unit, sizeInBit from subtypes', () => {
    const info = getDptInfo(pid);
    const entry = info['5.001'];
    assert.equal(entry.name, 'DPT_Scaling');
    assert.equal(entry.text, 'percentage (0..100%)');
    assert.equal(entry.unit, '%');
    assert.equal(entry.sizeInBit, 8);
  });

  it('extracts coefficient from UnsignedInteger', () => {
    const info = getDptInfo(pid);
    assert.equal(info['5.001'].coefficient, 0.4);
  });

  it('builds enums from Bit elements (Cleared/Set)', () => {
    const info = getDptInfo(pid);
    const enums = info['1.001'].enums;
    assert.ok(enums);
    assert.equal(enums[0], 'Off');
    assert.equal(enums[1], 'On');
  });

  it('builds enums from Enumeration/EnumValue elements', () => {
    const info = getDptInfo(pid);
    const enums = info['20.102'].enums;
    assert.ok(enums);
    assert.equal(enums[0], 'Auto');
    assert.equal(enums[1], 'Comfort');
    assert.equal(enums[2], 'Standby');
    assert.equal(enums[3], 'Economy');
    assert.equal(enums[4], 'Building Protection');
  });

  it('caches results (calling twice returns same object reference)', () => {
    const a = getDptInfo(pid);
    const b = getDptInfo(pid);
    assert.equal(a, b);
  });
});

// ── saveMasterXml / readMasterXml ──────────────────────────────────────────────

describe('saveMasterXml / readMasterXml', () => {
  const pid = `${uid}_rw`;
  const xmlPath = path.join(DATA_DIR, `knx_master_${pid}.xml`);
  tempFiles.push(xmlPath);

  it('saveMasterXml writes file, readMasterXml reads it back', () => {
    const xml = '<KNX><MasterData/></KNX>';
    saveMasterXml(pid, xml);
    assert.equal(readMasterXml(pid), xml);
  });

  it('readMasterXml returns null for nonexistent projectId', () => {
    assert.equal(readMasterXml(`${uid}_nofile`), null);
  });

  it('readMasterXml returns null when projectId is falsy', () => {
    assert.equal(readMasterXml(null), null);
    assert.equal(readMasterXml(undefined), null);
    assert.equal(readMasterXml(''), null);
  });

  it('saveMasterXml does nothing when xml is falsy', () => {
    const pid2 = `${uid}_noop`;
    saveMasterXml(pid2, null);
    assert.equal(readMasterXml(pid2), null);
    saveMasterXml(pid2, '');
    assert.equal(readMasterXml(pid2), null);
  });
});

// ── saveModelsAndMasterXml ─────────────────────────────────────────────────────

describe('saveModelsAndMasterXml', () => {
  const pid = `${uid}_models`;
  const xmlPath = path.join(DATA_DIR, `knx_master_${pid}.xml`);
  tempFiles.push(xmlPath);

  it('saves param model JSON files to APPS_DIR', () => {
    const appId = `${uid}_app1`;
    const model = { params: [1, 2, 3] };
    saveModelsAndMasterXml({ [appId]: model }, null, pid);
    const safe = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const jsonPath = path.join(APPS_DIR, safe + '.json');
    tempFiles.push(jsonPath);
    assert.ok(fs.existsSync(jsonPath));
    assert.deepEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), model);
  });

  it('sanitizes appId (replaces non-alphanumeric chars)', () => {
    const appId = 'M-0001/A-0002-00-0003';
    const model = { x: 1 };
    saveModelsAndMasterXml({ [appId]: model }, null, pid);
    const safe = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const jsonPath = path.join(APPS_DIR, safe + '.json');
    tempFiles.push(jsonPath);
    assert.ok(fs.existsSync(jsonPath));
    // The filename should have slashes replaced with underscores
    assert.ok(safe.includes('_'));
    assert.ok(!safe.includes('/'));
  });

  it('saves master XML via saveMasterXml', () => {
    const xml = '<KNX><Test/></KNX>';
    saveModelsAndMasterXml(null, xml, pid);
    assert.equal(readMasterXml(pid), xml);
  });

  it('does nothing when both args are null', () => {
    const pid2 = `${uid}_nothing`;
    // Should not throw
    saveModelsAndMasterXml(null, null, pid2);
    assert.equal(readMasterXml(pid2), null);
  });
});
