/**
 * Smoke tests against the ABB starter kit ETS6 project.
 * This project is NOT expected to change — values are hard-coded.
 * Parser tests run against both the plaintext and password-protected variants.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { type AddressInfo } from 'net';

const SMOKE_PROJECT = path.join(import.meta.dirname, 'smoke-test.knxproj');
const SMOKE_PROJECT_PW = path.join(
  import.meta.dirname,
  'password-protected-smoke-test.knxproj',
);

if (!fs.existsSync(SMOKE_PROJECT)) {
  describe('Smoke tests', () => {
    it('skipped — tests/smoke-test.knxproj not found', () => {});
  });
  process.exit(0);
}

const { parseKnxproj } = await import('../server/ets-parser.ts');

let server: any, baseUrl: string, db: any, parsed: any;

async function req(
  method: string,
  urlPath: string,
  body?: any,
  isFormData = false,
) {
  const url = baseUrl + urlPath;
  const headers: Record<string, string> = {};
  const opts: RequestInit = { method, headers };
  if (body && !isFormData) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (isFormData) {
    opts.body = body;
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

before(async () => {
  db = await import('../server/db.ts');
  await db.init({ inMemory: true });
  const { router: routes } = await import('../server/routes/index.ts');
  const { ValidationError } = await import('../server/validate.ts');
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.errors.join('; ') });
        return;
      }
      res.status(500).json({ error: err.message || 'Internal server error' });
    },
  );
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${(server.address() as AddressInfo).port}/api`;
      resolve();
    });
  });
  // Parse once, reuse across tests
  const buf = fs.readFileSync(SMOKE_PROJECT);
  parsed = parseKnxproj(buf);
});

after(() => {
  server?.close();
});

// ── Shared parser assertions (reused for plaintext and encrypted) ───────────

function assertParserOutput(
  getParsed: () => any,
  label: string,
  expectedName = 'Smoke Test',
) {
  // getParsed is a thunk so the value is resolved at test time, not registration time
  describe(`${label}: project metadata`, () => {
    it(`project name is "${expectedName}"`, () => {
      assert.equal(getParsed().projectName, expectedName);
    });

    it('projectInfo is an object', () => {
      assert(typeof getParsed().projectInfo === 'object');
    });

    it('knxMasterXml is a non-empty string', () => {
      assert(typeof getParsed().knxMasterXml === 'string');
      assert(getParsed().knxMasterXml.length > 1000);
    });
  });

  describe(`${label}: devices`, () => {
    it('extracts exactly 6 devices', () => {
      assert.equal(getParsed().devices.length, 6);
    });

    const EXPECTED_DEVICES = [
      {
        ia: '1.1.0',
        name: 'SV/S30.160.1.1 Power Supply,160mA,MDRC',
        order: '2CDG 110 144 R0011',
        hasApp: false,
        paramCount: 0,
      },
      {
        ia: '1.1.1',
        name: 'USB/S1.2 USB Interface, MDRC',
        order: '2CDG 110 243 R0011',
        hasApp: false,
        paramCount: 0,
      },
      {
        ia: '1.1.2',
        name: 'SAH/S8.6.7.1 Switch/Shutter Act, 8-f, 6A, MDRC',
        order: '2CDG 110 244 R0011',
        hasApp: true,
        paramCount: 213,
      },
      {
        ia: '1.1.3',
        name: 'UD/S4.210.2.1 LED Dimmer 4x210W',
        order: '2CKA006197A0047',
        hasApp: true,
        paramCount: 110,
      },
      {
        ia: '1.1.4',
        name: 'US/U2.2 Universal Interface,2-fold,FM',
        order: 'GH Q631 0074 R0111',
        hasApp: true,
        paramCount: 13,
      },
      {
        ia: '1.1.5',
        name: '6108/07-500 Push-button coupling unit 4gang, FM',
        order: '6108/07-500',
        hasApp: true,
        paramCount: 30,
      },
    ];

    for (const exp of EXPECTED_DEVICES) {
      it(`device ${exp.ia} — ${exp.name.substring(0, 30)}`, () => {
        const d = getParsed().devices.find(
          (d) => d.individual_address === exp.ia,
        );
        assert(d, `device ${exp.ia} not found`);
        assert.equal(d.name, exp.name);
        assert.equal(d.manufacturer, 'ABB AG - STOTZ-KONTAKT');
        assert.equal(d.order_number, exp.order);
        assert.equal(d.area, 1);
        assert.equal(d.line, 1);
        assert.equal(d.medium, 'TP');
        assert.equal(!!d.app_ref, exp.hasApp, `app_ref expected ${exp.hasApp}`);
        assert.equal(
          (d.parameters || []).length,
          exp.paramCount,
          `param count for ${exp.ia}`,
        );
      });
    }

    it('SAH/S8.6.7.1 (1.1.2) has 16 non-default param values', () => {
      const d = getParsed().devices.find(
        (d) => d.individual_address === '1.1.2',
      );
      assert.equal(Object.keys(d.param_values || {}).length, 16);
    });

    it('power supply (1.1.0) has no application program', () => {
      const d = getParsed().devices.find(
        (d) => d.individual_address === '1.1.0',
      );
      assert.equal(d.app_ref, '');
      assert.equal((d.parameters || []).length, 0);
    });

    it('push-button coupler (1.1.5) is typed as sensor', () => {
      const d = getParsed().devices.find(
        (d) => d.individual_address === '1.1.5',
      );
      assert.equal(d.device_type, 'sensor');
    });
  });

  describe(`${label}: group addresses`, () => {
    it('extracts exactly 4 group addresses', () => {
      assert.equal(getParsed().groupAddresses.length, 4);
    });

    const EXPECTED_GAS = [
      {
        address: '1/0/0',
        name: 'Chandelier On/Off',
        dpt: 'DPST-1-1',
        mainGroupName: 'Lighting',
        middleGroupName: 'Kitchen',
      },
      {
        address: '2/0/0',
        name: 'Blind Up/Down',
        dpt: '',
        mainGroupName: 'Blinds',
        middleGroupName: 'Kitchen',
      },
      {
        address: '11/0/0',
        name: 'Chandelier Status',
        dpt: 'DPST-1-1',
        mainGroupName: 'Lighting Status',
        middleGroupName: 'Kitchen',
      },
      {
        address: '12/0/0',
        name: 'Blind Percentage',
        dpt: '',
        mainGroupName: 'Blinds Status',
        middleGroupName: 'Kitchen',
      },
    ];

    for (const exp of EXPECTED_GAS) {
      it(`GA ${exp.address} — ${exp.name}`, () => {
        const g = getParsed().groupAddresses.find(
          (g) => g.address === exp.address,
        );
        assert(g, `GA ${exp.address} not found`);
        assert.equal(g.name, exp.name);
        assert.equal(g.dpt, exp.dpt);
        assert.equal(g.mainGroupName, exp.mainGroupName);
        assert.equal(g.middleGroupName, exp.middleGroupName);
      });
    }
  });

  describe(`${label}: communication objects`, () => {
    it('extracts exactly 38 com objects', () => {
      assert.equal(getParsed().comObjects.length, 38);
    });

    it('SAH/S8.6.7.1 (1.1.2) has 12 com objects with correct object numbers', () => {
      const cos = getParsed().comObjects.filter(
        (co) => co.device_address === '1.1.2',
      );
      assert.equal(cos.length, 12);
      const nums = cos.map((co) => co.object_number).sort((a, b) => a - b);
      assert.deepEqual(
        nums,
        [4, 13, 14, 15, 144, 145, 187, 188, 230, 231, 273, 274],
      );
    });

    it('UD/S4.210.2.1 (1.1.3) has 21 com objects', () => {
      const cos = getParsed().comObjects.filter(
        (co) => co.device_address === '1.1.3',
      );
      assert.equal(cos.length, 21);
    });

    it('LED dimmer channel A switching is linked to Chandelier On/Off and Status', () => {
      const co = getParsed().comObjects.find(
        (co) => co.device_address === '1.1.3' && co.object_number === 7,
      );
      assert(co, 'dimmer channel A switching CO not found');
      assert(
        co.ga_address.includes('1/0/0'),
        'should be linked to Chandelier On/Off',
      );
      assert(
        co.ga_address.includes('11/0/0'),
        'should be linked to Chandelier Status',
      );
    });

    it('push-button coupler (1.1.5) has 3 com objects', () => {
      const cos = getParsed().comObjects.filter(
        (co) => co.device_address === '1.1.5',
      );
      assert.equal(cos.length, 3);
      const nums = cos.map((co) => co.object_number).sort((a, b) => a - b);
      assert.deepEqual(nums, [1, 2, 16]);
    });

    it('power supply and USB interface have no com objects', () => {
      assert.equal(
        getParsed().comObjects.filter((co) => co.device_address === '1.1.0')
          .length,
        0,
      );
      assert.equal(
        getParsed().comObjects.filter((co) => co.device_address === '1.1.1')
          .length,
        0,
      );
    });
  });

  describe(`${label}: topology`, () => {
    it('extracts exactly 5 topology entries', () => {
      assert.equal(getParsed().topologyEntries.length, 5);
    });

    it('has 2 areas and 3 lines', () => {
      const areas = getParsed().topologyEntries.filter((t) => t.line === null);
      const lines = getParsed().topologyEntries.filter((t) => t.line !== null);
      assert.equal(areas.length, 2);
      assert.equal(lines.length, 3);
    });

    it('all devices are on area 1 line 1', () => {
      for (const d of getParsed().devices) {
        assert.equal(d.area, 1, `${d.individual_address} area`);
        assert.equal(d.line, 1, `${d.individual_address} line`);
      }
    });
  });

  describe(`${label}: spaces`, () => {
    it('extracts exactly 4 spaces', () => {
      assert.equal(getParsed().spaces.length, 4);
    });

    it('building hierarchy: Smoke Test > Ground Floor > Kitchen > Cabinet', () => {
      const building = getParsed().spaces.find((s) => s.type === 'Building');
      assert(building);
      assert.equal(building.name, 'Smoke Test');
      assert.equal(building.parent_idx, null);

      const floor = getParsed().spaces.find((s) => s.type === 'Floor');
      assert(floor);
      assert.equal(floor.name, 'Ground Floor');
      assert.equal(floor.parent_idx, 0);

      const room = getParsed().spaces.find((s) => s.type === 'Room');
      assert(room);
      assert.equal(room.name, 'Kitchen');
      assert.equal(room.parent_idx, 1);

      const db = getParsed().spaces.find((s) => s.type === 'DistributionBoard');
      assert(db);
      assert.equal(db.name, 'Cabinet');
      assert.equal(db.parent_idx, 2);
    });

    it('device-to-space assignments are correct', () => {
      assert.equal(getParsed().devSpaceMap['1.1.4'], 2);
      assert.equal(getParsed().devSpaceMap['1.1.5'], 2);
      assert.equal(getParsed().devSpaceMap['1.1.0'], 3);
      assert.equal(getParsed().devSpaceMap['1.1.1'], 3);
      assert.equal(getParsed().devSpaceMap['1.1.2'], 3);
      assert.equal(getParsed().devSpaceMap['1.1.3'], 3);
    });
  });

  describe(`${label}: catalog`, () => {
    it('extracts 12 catalog sections and 6 catalog items', () => {
      assert.equal(getParsed().catalogSections.length, 12);
      assert.equal(getParsed().catalogItems.length, 6);
    });

    it('all catalog items are from ABB', () => {
      for (const item of getParsed().catalogItems) {
        assert.equal(item.manufacturer, 'ABB AG - STOTZ-KONTAKT');
        assert.equal(item.mfr_id, 'M-0002');
      }
    });

    it('catalog items have correct order numbers', () => {
      const orders = getParsed()
        .catalogItems.map((i) => i.order_number)
        .sort();
      assert.deepEqual(orders, [
        '2CDG 110 144 R0011',
        '2CDG 110 243 R0011',
        '2CDG 110 244 R0011',
        '2CKA006197A0047',
        '6108/07-500',
        'GH Q631 0074 R0111',
      ]);
    });

    it('each catalog item has correct name and product_ref', () => {
      const items = getParsed().catalogItems;
      const byOrder: Record<string, (typeof items)[0]> = {};
      for (const i of items) byOrder[i.order_number] = i;

      const psu = byOrder['2CDG 110 144 R0011'];
      assert(psu, 'power supply item missing');
      assert.equal(psu.name, 'SV/S30.160.1.1 Power Supply,160mA,MDRC');
      assert(psu.product_ref, 'should have product_ref');

      const usb = byOrder['2CDG 110 243 R0011'];
      assert(usb, 'USB interface item missing');
      assert.equal(usb.name, 'USB/S1.2 USB Interface, MDRC');

      const shutter = byOrder['2CDG 110 244 R0011'];
      assert(shutter, 'shutter actuator item missing');
      assert.equal(
        shutter.name,
        'SAH/S8.6.7.1 Switch/Shutter Act, 8-f, 6A, MDRC',
      );

      const dimmer = byOrder['2CKA006197A0047'];
      assert(dimmer, 'dimmer item missing');
      assert.equal(dimmer.name, 'UD/S4.210.2.1 LED Dimmer 4x210W');

      const uif = byOrder['GH Q631 0074 R0111'];
      assert(uif, 'universal interface item missing');
      assert.equal(uif.name, 'US/U2.2 Universal Interface,2-fold,FM');

      const pushbutton = byOrder['6108/07-500'];
      assert(pushbutton, 'push-button item missing');
      assert.equal(
        pushbutton.name,
        '6108/07-500 Push-button coupling unit 4gang, FM',
      );
    });

    it('catalog items are assigned to correct sections', () => {
      const items = getParsed().catalogItems;
      const sections = getParsed().catalogSections;
      const secById: Record<string, (typeof sections)[0]> = {};
      for (const s of sections) secById[s.id] = s;

      for (const item of items) {
        assert(item.section_id, `item ${item.name} should have section_id`);
        const sec = secById[item.section_id];
        assert(
          sec,
          `section ${item.section_id} for item ${item.name} not found`,
        );
      }
    });

    it('catalog sections include expected categories', () => {
      const numbers = getParsed().catalogSections.map((s) => s.number);
      assert(numbers.includes('POSU'), 'should have Power Supply section');
      assert(numbers.includes('STOU'), 'should have Standard Outputs section');
      assert(numbers.includes('LICO'), 'should have Lighting Control section');
      assert(numbers.includes('STIN'), 'should have Standard Inputs section');
      assert(numbers.includes('CEPB'), 'should have Push Button section');
    });

    it('catalog sections form a tree (root sections have no parent)', () => {
      const sections = getParsed().catalogSections;
      const roots = sections.filter((s) => !s.parent_id);
      assert(roots.length >= 1, 'should have at least one root section');
      const children = sections.filter((s) => s.parent_id);
      for (const child of children) {
        const parent = sections.find((s) => s.id === child.parent_id);
        assert(
          parent,
          `section "${child.name}" has parent_id ${child.parent_id} but parent not found`,
        );
      }
    });
  });

  describe(`${label}: param models`, () => {
    it('extracts 7 application program models', () => {
      assert.equal(Object.keys(getParsed().paramModels).length, 7);
    });

    it('SAH/S8.6.7.1 model has 3285 params and 14 load procedures', () => {
      const m = parsed.paramModels['M-0002_A-A0C9-13-84CD'];
      assert(m, 'model not found');
      assert.equal(Object.keys(m.params).length, 3285);
      assert.equal(m.loadProcedures.length, 14);
    });

    it('UD/S4.210.2.1 model has 893 params and 14 load procedures', () => {
      const m = parsed.paramModels['M-0002_A-4A14-12-FB94-O0007'];
      assert(m, 'model not found');
      assert.equal(Object.keys(m.params).length, 893);
      assert.equal(m.loadProcedures.length, 14);
    });
  });
}

// ── Run parser tests against plaintext file ─────────────────────────────────

assertParserOutput(() => parsed, 'Smoke');

// ── Run parser tests against password-protected file ────────────────────────

if (fs.existsSync(SMOKE_PROJECT_PW)) {
  const pwBuf = fs.readFileSync(SMOKE_PROJECT_PW);
  const pwParsed = parseKnxproj(pwBuf, 'k00l3n3x!');
  assertParserOutput(
    () => pwParsed,
    'Smoke (encrypted)',
    'Password Protected Smoke Test',
  );

  describe('Smoke (encrypted): password handling', () => {
    it('rejects missing password with PASSWORD_REQUIRED', () => {
      assert.throws(
        () => parseKnxproj(pwBuf),
        (err) => err.code === 'PASSWORD_REQUIRED',
      );
    });

    it('rejects wrong password with PASSWORD_INCORRECT', () => {
      assert.throws(
        () => parseKnxproj(pwBuf, 'wrongpassword'),
        (err) => err.code === 'PASSWORD_INCORRECT',
      );
    });
  });
}

// ── API: Import and full roundtrip ──────────────────────────────────────────

describe('Smoke: API import', () => {
  let pid;

  it('imports via POST /projects/import', async () => {
    const buf = fs.readFileSync(SMOKE_PROJECT);
    const form = new FormData();
    form.append('file', new Blob([buf]), 'smoke-test.knxproj');
    const { status, data } = await req('POST', '/projects/import', form, true);
    assert.equal(status, 200, `import failed: ${JSON.stringify(data)}`);
    assert(data.projectId);
    assert.equal(data.summary.devices, 6);
    assert.equal(data.summary.groupAddresses, 4);
    assert.equal(data.summary.comObjects, 38);
    pid = data.projectId;
  });

  it('GET /projects/:id returns correct counts', async () => {
    const { status, data } = await req('GET', `/projects/${pid}`);
    assert.equal(status, 200);
    assert.equal(data.project.name, 'Smoke Test');
    assert.equal(data.devices.length, 6);
    assert.equal(data.gas.length, 4);
    assert.equal(data.comObjects.length, 38);
    assert.equal(data.spaces.length, 4);
    assert(data.topology.length >= 5);
  });

  it('devices in database have correct manufacturer from knx_master.xml', () => {
    const devs = db.all('SELECT * FROM devices WHERE project_id=?', [pid]);
    for (const d of devs) {
      assert.equal(
        d.manufacturer,
        'ABB AG - STOTZ-KONTAKT',
        `${d.individual_address} manufacturer`,
      );
    }
  });

  it('topology table has areas and lines', () => {
    const rows = db.all('SELECT * FROM topology WHERE project_id=?', [pid]);
    const areas = rows.filter((r) => r.line === null);
    const lines = rows.filter((r) => r.line !== null);
    assert.equal(areas.length, 2);
    assert.equal(lines.length, 3);
  });

  it('ga_group_names has main and middle group names', () => {
    const names = db.all('SELECT * FROM ga_group_names WHERE project_id=?', [
      pid,
    ]);
    const mainNames = names.filter((n) => n.middle_g === -1);
    const midNames = names.filter((n) => n.middle_g !== -1);
    assert(mainNames.length >= 1);
    assert(midNames.length >= 1);
    assert(mainNames.some((n) => n.name === 'Lighting'));
    assert(midNames.some((n) => n.name === 'Kitchen'));
  });

  it('catalog tables are populated', () => {
    const sections = db.all(
      'SELECT * FROM catalog_sections WHERE project_id=?',
      [pid],
    );
    const items = db.all('SELECT * FROM catalog_items WHERE project_id=?', [
      pid,
    ]);
    assert.equal(sections.length, 12);
    assert.equal(items.length, 6);
  });

  it('audit log has an import entry', () => {
    const rows = db.all(
      "SELECT * FROM audit_log WHERE project_id=? AND action='import'",
      [pid],
    );
    assert(rows.length >= 1);
    assert(rows[0].detail.includes('6 devices'));
  });

  it('reimport succeeds with same counts', async () => {
    const buf = fs.readFileSync(SMOKE_PROJECT);
    const form = new FormData();
    form.append('file', new Blob([buf]), 'smoke-test.knxproj');
    const { status, data } = await req(
      'POST',
      `/projects/${pid}/reimport`,
      form,
      true,
    );
    assert.equal(status, 200, `reimport failed: ${JSON.stringify(data)}`);
    assert.equal(data.summary.devices, 6);
    assert.equal(data.summary.groupAddresses, 4);
    assert.equal(data.summary.comObjects, 38);
  });

  it('cleanup — delete project', async () => {
    await req('DELETE', `/projects/${pid}`);
    assert.equal(db.get('SELECT * FROM projects WHERE id=?', [pid]), null);
    assert.equal(
      db.get('SELECT count(*) as c FROM devices WHERE project_id=?', [pid]).c,
      0,
    );
    assert.equal(
      db.get('SELECT count(*) as c FROM topology WHERE project_id=?', [pid]).c,
      0,
    );
    assert.equal(
      db.get('SELECT count(*) as c FROM catalog_items WHERE project_id=?', [
        pid,
      ]).c,
      0,
    );
  });
});

// ── Import/Reimport Error Paths ─────────────────────────────────────────────

describe('Import/Reimport Error Paths', () => {
  it('POST /import with no file returns 400', async () => {
    const { status, data } = await req(
      'POST',
      '/projects/import',
      new FormData(),
      true,
    );
    assert.equal(status, 400);
    assert.equal(data.error, 'No file uploaded');
  });

  it('POST /import with wrong file extension returns 400', async () => {
    const form = new FormData();
    form.append('file', new Blob(['not a knxproj']), 'readme.txt');
    const { status, data } = await req('POST', '/projects/import', form, true);
    assert.equal(status, 400);
    assert.equal(data.error, 'File must be a .knxproj file');
  });

  it('POST /import with corrupt .knxproj returns 422', async () => {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.from('this is not a valid knxproj file')]),
      'corrupt.knxproj',
    );
    const { status, data } = await req('POST', '/projects/import', form, true);
    assert.equal(status, 422);
    assert.equal(data.error, 'Parse failed');
  });

  it('POST /import with binary (non-XML, non-encrypted) buffer returns 422', async () => {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02])]),
      'binary.knxproj',
    );
    const { status, data } = await req('POST', '/projects/import', form, true);
    assert.equal(status, 422);
  });

  it('POST /reimport with no file returns 400', async () => {
    const { data: proj } = await req('POST', '/projects', {
      name: 'Reimport Error Test',
    });
    const form = new FormData();
    const { status, data } = await req(
      'POST',
      `/projects/${proj.id}/reimport`,
      form,
      true,
    );
    assert.equal(status, 400);
    assert.equal(data.error, 'No file uploaded');
    await req('DELETE', `/projects/${proj.id}`);
  });

  it('POST /reimport with wrong file extension returns 400', async () => {
    const { data: proj } = await req('POST', '/projects', {
      name: 'Reimport Error Test',
    });
    const form = new FormData();
    form.append('file', new Blob(['not a knxproj']), 'fake.xml');
    const { status, data } = await req(
      'POST',
      `/projects/${proj.id}/reimport`,
      form,
      true,
    );
    assert.equal(status, 400);
    assert.equal(data.error, 'File must be a .knxproj file');
    await req('DELETE', `/projects/${proj.id}`);
  });

  it('POST /reimport with nonexistent project returns 404', async () => {
    const buf = fs.readFileSync(SMOKE_PROJECT);
    const form = new FormData();
    form.append('file', new Blob([buf]), 'smoke-test.knxproj');
    const { status } = await req(
      'POST',
      '/projects/99999/reimport',
      form,
      true,
    );
    assert.equal(status, 404);
  });

  it('POST /reimport with corrupt .knxproj returns 422', async () => {
    const { data: proj } = await req('POST', '/projects', {
      name: 'Reimport Error Test',
    });
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('corrupt data')]), 'bad.knxproj');
    const { status, data } = await req(
      'POST',
      `/projects/${proj.id}/reimport`,
      form,
      true,
    );
    assert.equal(status, 422);
    await req('DELETE', `/projects/${proj.id}`);
  });
});
