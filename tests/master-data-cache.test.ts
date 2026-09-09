/**
 * The master-data caches must follow the file they were parsed from.
 *
 * Each of /dpt-info, /space-usages, /translations, /medium-types and
 * /mask-versions parses knx_master_<projectId>.xml once and caches the
 * result per project. Nothing cleared those caches, so a reimport into an
 * existing project id - which rewrites that file - went on serving the
 * previous import's data for the life of the server process. saveMasterXml
 * now clears them, and these tests fail against the version that didn't.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createTestServer, req, type TestServer } from './helpers.ts';
import {
  saveMasterXml,
  clearMasterDataCaches,
  DATA_DIR,
  _spaceUsageCache,
  _mediumTypeCache,
} from '../server/routes/shared.ts';

/** A complete-enough master XML whose every text carries `label`. */
function masterXml(label: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <MasterData>
    <DatapointTypes>
      <DatapointType Id="DPT-1" Number="1" Text="${label} switch" SizeInBit="1">
        <DatapointSubtypes>
          <DatapointSubtype Id="DPST-1-1" Number="1" Name="DPT_Switch"
                            Text="${label} on/off">
            <Format>
              <Bit Cleared="${label} off" Set="${label} on"/>
            </Format>
          </DatapointSubtype>
        </DatapointSubtypes>
      </DatapointType>
    </DatapointTypes>
    <SpaceUsages>
      <SpaceUsage Id="SU-1" Number="1" Text="${label} kitchen"/>
    </SpaceUsages>
    <MediumTypes>
      <MediumType Id="MT-0" Name="TP" Text="${label} twisted pair"/>
    </MediumTypes>
    <MaskVersions>
      <MaskVersion MaskVersion="1968" Name="${label} mask"
                   ManagementModel="Bcu1" MediumTypeRefId="MT-0"/>
    </MaskVersions>
    <Languages>
      <Language Identifier="de-DE">
        <TranslationUnit RefId="M-0001">
          <TranslationElement RefId="DPST-1-1">
            <Translation AttributeName="Text" Text="${label} Ein/Aus"/>
          </TranslationElement>
        </TranslationUnit>
      </Language>
    </Languages>
  </MasterData>
</KNX>`;
}

const pid = `test_mdcache_${Date.now()}`;
let ts: TestServer;

before(async () => {
  ts = await createTestServer();
});

after(() => {
  ts?.close();
  try {
    fs.unlinkSync(path.join(DATA_DIR, `knx_master_${pid}.xml`));
  } catch (_) {}
});

describe('master-data caches follow a rewritten master XML', () => {
  it('serves the first version', async () => {
    saveMasterXml(pid, masterXml('first'));

    const su = await req(ts.baseUrl, 'GET', `/space-usages?projectId=${pid}`);
    assert.equal(su.status, 200);
    assert.equal(
      (su.data as Array<{ text: string }>)[0]?.text,
      'first kitchen',
    );

    const dpt = await req(ts.baseUrl, 'GET', `/dpt-info?projectId=${pid}`);
    assert.equal(
      (dpt.data as Record<string, { text: string }>)['1.001']?.text,
      'first on/off',
    );

    const mt = await req(ts.baseUrl, 'GET', `/medium-types?projectId=${pid}`);
    assert.equal(
      (mt.data as Record<string, string>)['TP'],
      'first twisted pair',
    );

    const mv = await req(ts.baseUrl, 'GET', `/mask-versions?projectId=${pid}`);
    assert.equal(
      (mv.data as Record<string, { name: string }>)['07b0']?.name,
      'first mask',
    );

    const tr = await req(ts.baseUrl, 'GET', `/translations?projectId=${pid}`);
    assert.equal(
      (tr.data as { translations: Record<string, Record<string, string>> })
        .translations['de-DE']?.['DPST-1-1'],
      'first Ein/Aus',
    );
  });

  it('serves the second version after the file is rewritten', async () => {
    // Exactly what a reimport into this project id does.
    saveMasterXml(pid, masterXml('second'));

    const su = await req(ts.baseUrl, 'GET', `/space-usages?projectId=${pid}`);
    assert.equal(
      (su.data as Array<{ text: string }>)[0]?.text,
      'second kitchen',
    );

    const dpt = await req(ts.baseUrl, 'GET', `/dpt-info?projectId=${pid}`);
    assert.equal(
      (dpt.data as Record<string, { text: string }>)['1.001']?.text,
      'second on/off',
    );

    const mt = await req(ts.baseUrl, 'GET', `/medium-types?projectId=${pid}`);
    assert.equal(
      (mt.data as Record<string, string>)['TP'],
      'second twisted pair',
    );

    const mv = await req(ts.baseUrl, 'GET', `/mask-versions?projectId=${pid}`);
    assert.equal(
      (mv.data as Record<string, { name: string }>)['07b0']?.name,
      'second mask',
    );

    const tr = await req(ts.baseUrl, 'GET', `/translations?projectId=${pid}`);
    assert.equal(
      (tr.data as { translations: Record<string, Record<string, string>> })
        .translations['de-DE']?.['DPST-1-1'],
      'second Ein/Aus',
    );
  });
});

describe('clearMasterDataCaches', () => {
  it('clears one project without touching another', () => {
    _spaceUsageCache['p1'] = [{ id: 'a', number: 1, text: 'a' }];
    _spaceUsageCache['p2'] = [{ id: 'b', number: 2, text: 'b' }];
    clearMasterDataCaches('p1');
    assert.equal(_spaceUsageCache['p1'], undefined);
    assert.ok(_spaceUsageCache['p2']);
  });

  it('treats a numeric and a string project id as the same key', () => {
    _mediumTypeCache[7] = { TP: 'tp' };
    clearMasterDataCaches('7');
    assert.equal(_mediumTypeCache[7], undefined);
  });

  it('clears every project when called with no argument', () => {
    _spaceUsageCache['p3'] = [{ id: 'c', number: 3, text: 'c' }];
    _mediumTypeCache['p4'] = { TP: 'tp' };
    clearMasterDataCaches();
    assert.deepEqual(Object.keys(_spaceUsageCache), []);
    assert.deepEqual(Object.keys(_mediumTypeCache), []);
  });
});
