'use strict';
/**
 * Smoke tests against the ABB starter kit ETS6 project.
 * This project is NOT expected to change — values are hard-coded.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('path');
const fs = require('fs');

const SMOKE_PROJECT = path.join(__dirname, 'smoke-test.knxproj');

if (!fs.existsSync(SMOKE_PROJECT)) {
  describe('Smoke tests', () => {
    it('skipped — tests/smoke-test.knxproj not found', () => {});
  });
  return;
}

const { parseKnxproj } = require('../server/ets-parser');

let server, baseUrl, db, parsed;

async function req(method, urlPath, body, isFormData = false) {
  const url = baseUrl + urlPath;
  const opts = { method, headers: {} };
  if (body && !isFormData) {
    opts.headers['Content-Type'] = 'application/json';
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
  db = require('../server/db');
  await db.init();
  const routes = require('../server/routes');
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}/api`;
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

// ── Parser: Project ─────────────────────────────────────────────────────────

describe('Smoke: project metadata', () => {
  it('project name is "Smoke Test"', () => {
    assert.equal(parsed.projectName, 'Smoke Test');
  });

  it('projectInfo is an object', () => {
    assert(typeof parsed.projectInfo === 'object');
  });

  it('knxMasterXml is a non-empty string', () => {
    assert(typeof parsed.knxMasterXml === 'string');
    assert(parsed.knxMasterXml.length > 1000);
  });
});

// ── Parser: Devices ─────────────────────────────────────────────────────────

describe('Smoke: devices', () => {
  it('extracts exactly 6 devices', () => {
    assert.equal(parsed.devices.length, 6);
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
      const d = parsed.devices.find((d) => d.individual_address === exp.ia);
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
    const d = parsed.devices.find((d) => d.individual_address === '1.1.2');
    assert.equal(Object.keys(d.param_values || {}).length, 16);
  });

  it('power supply (1.1.0) has no application program', () => {
    const d = parsed.devices.find((d) => d.individual_address === '1.1.0');
    assert.equal(d.app_ref, '');
    assert.equal((d.parameters || []).length, 0);
  });

  it('push-button coupler (1.1.5) is typed as sensor', () => {
    const d = parsed.devices.find((d) => d.individual_address === '1.1.5');
    assert.equal(d.device_type, 'sensor');
  });
});

// ── Parser: Group Addresses ─────────────────────────────────────────────────

describe('Smoke: group addresses', () => {
  it('extracts exactly 4 group addresses', () => {
    assert.equal(parsed.groupAddresses.length, 4);
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
      const g = parsed.groupAddresses.find((g) => g.address === exp.address);
      assert(g, `GA ${exp.address} not found`);
      assert.equal(g.name, exp.name);
      assert.equal(g.dpt, exp.dpt);
      assert.equal(g.mainGroupName, exp.mainGroupName);
      assert.equal(g.middleGroupName, exp.middleGroupName);
    });
  }
});

// ── Parser: Communication Objects ───────────────────────────────────────────

describe('Smoke: communication objects', () => {
  it('extracts exactly 38 com objects', () => {
    assert.equal(parsed.comObjects.length, 38);
  });

  it('SAH/S8.6.7.1 (1.1.2) has exactly these 12 com objects', () => {
    const cos = parsed.comObjects.filter((co) => co.device_address === '1.1.2');
    assert.equal(cos.length, 12);
    const byNum = Object.fromEntries(cos.map((co) => [co.object_number, co]));

    // General COs (from Device settings and Manual operation channels)
    assert(byNum[4], 'CO #4 should exist');
    assert.equal(byNum[4].name, 'Central - Load shedding');
    assert.equal(byNum[4].function_text, 'Receive load shedding stage');
    assert.equal(byNum[4].channel, 'Device settings');

    assert(byNum[13], 'CO #13 should exist');
    assert.equal(byNum[13].name, 'Manual operation - Manual operation');
    assert.equal(byNum[13].function_text, 'Status Manual operation');
    assert.equal(byNum[13].channel, 'Manual operation');

    assert(byNum[14], 'CO #14 should exist');
    assert.equal(byNum[14].name, 'Manual operation - Manual operation');
    assert.equal(byNum[14].function_text, 'Enable/Block manual operation');
    assert.equal(byNum[14].channel, 'Manual operation');

    assert(byNum[15], 'CO #15 should exist');
    assert.equal(byNum[15].name, 'Manual operation - Manual operation');
    assert.equal(byNum[15].function_text, 'Ending manual operation');
    assert.equal(byNum[15].channel, 'Manual operation');

    // Per-channel shutter COs (channels A, C, E, G — configured as Shutter Actuator)
    assert(byNum[144], 'CO #144 (Channel A shutter) should exist');
    assert.equal(byNum[144].name, 'Channel A - Shutter');
    assert.equal(byNum[144].function_text, 'Move Blind/Shutter Up/Down');
    assert.equal(byNum[144].channel, 'Shutter Actuator A+B');

    assert(byNum[145], 'CO #145 (Channel A slat) should exist');
    assert.equal(byNum[145].name, 'Channel A - Shutter');
    assert.equal(byNum[145].function_text, 'Slat adjustment / Stop Up/Down');
    assert.equal(byNum[145].channel, 'Shutter Actuator A+B');

    assert(byNum[187], 'CO #187 (Channel C shutter) should exist');
    assert.equal(byNum[187].channel, 'Shutter Actuator C+D');
    assert(byNum[188], 'CO #188 (Channel C slat) should exist');
    assert.equal(byNum[188].channel, 'Shutter Actuator C+D');
    assert(byNum[230], 'CO #230 (Channel E shutter) should exist');
    assert.equal(byNum[230].channel, 'Shutter Actuator E+F');
    assert(byNum[231], 'CO #231 (Channel E slat) should exist');
    assert.equal(byNum[231].channel, 'Shutter Actuator E+F');
    assert(byNum[273], 'CO #273 (Channel G shutter) should exist');
    assert.equal(byNum[273].channel, 'Shutter Actuator G+H');
    assert(byNum[274], 'CO #274 (Channel G slat) should exist');
    assert.equal(byNum[274].channel, 'Shutter Actuator G+H');

    // Verify NO threshold COs are present (logic gate function defaults to None)
    for (const co of cos) {
      assert(
        !co.name?.includes('Threshold'),
        `CO #${co.object_number} "${co.name}" should not be a threshold CO`,
      );
    }

    // Verify exact set of object numbers
    const nums = cos.map((co) => co.object_number).sort((a, b) => a - b);
    assert.deepEqual(
      nums,
      [4, 13, 14, 15, 144, 145, 187, 188, 230, 231, 273, 274],
    );
  });

  it('UD/S4.210.2.1 (1.1.3) has exactly these 21 com objects', () => {
    const cos = parsed.comObjects.filter((co) => co.device_address === '1.1.3');
    assert.equal(cos.length, 21);
    const byNum = Object.fromEntries(cos.map((co) => [co.object_number, co]));

    const expected = [
      {
        num: 2,
        name: 'Central: Switching',
        ft: 'Input',
        ch: 'Device settings',
      },
      { num: 3, name: 'Central: Dimming', ft: 'Input', ch: 'Device settings' },
      { num: 4, name: 'Central: Value', ft: 'Input', ch: 'Device settings' },
      {
        num: 5,
        name: 'Central: Activate switch-off brightness',
        ft: 'Input',
        ch: 'Device settings',
      },
      { num: 6, name: 'Scene: Scene', ft: 'Input', ch: 'Scenes' },
      { num: 7, name: 'Channel A: Switching', ft: 'Input', ch: 'Channel A' },
      {
        num: 8,
        name: 'Channel A: Relative dimming',
        ft: 'Input',
        ch: 'Channel A',
      },
      {
        num: 9,
        name: 'Channel A: Brightness value',
        ft: 'Input',
        ch: 'Channel A',
      },
      {
        num: 12,
        name: 'Channel A: Flexible dimming time',
        ft: 'Input',
        ch: 'Channel A',
      },
      { num: 18, name: 'Channel B: Switching', ft: 'Input', ch: 'Channel B' },
      {
        num: 19,
        name: 'Channel B: Relative dimming',
        ft: 'Input',
        ch: 'Channel B',
      },
      {
        num: 20,
        name: 'Channel B: Brightness value',
        ft: 'Input',
        ch: 'Channel B',
      },
      {
        num: 23,
        name: 'Channel B: Flexible dimming time',
        ft: 'Input',
        ch: 'Channel B',
      },
      { num: 29, name: 'Channel C: Switching', ft: 'Input', ch: 'Channel C' },
      {
        num: 30,
        name: 'Channel C: Relative dimming',
        ft: 'Input',
        ch: 'Channel C',
      },
      {
        num: 31,
        name: 'Channel C: Brightness value',
        ft: 'Input',
        ch: 'Channel C',
      },
      {
        num: 34,
        name: 'Channel C: Flexible dimming time',
        ft: 'Input',
        ch: 'Channel C',
      },
      { num: 40, name: 'Channel D: Switching', ft: 'Input', ch: 'Channel D' },
      {
        num: 41,
        name: 'Channel D: Relative dimming',
        ft: 'Input',
        ch: 'Channel D',
      },
      {
        num: 42,
        name: 'Channel D: Brightness value',
        ft: 'Input',
        ch: 'Channel D',
      },
      {
        num: 45,
        name: 'Channel D: Flexible dimming time',
        ft: 'Input',
        ch: 'Channel D',
      },
    ];
    for (const e of expected) {
      assert(byNum[e.num], `CO #${e.num} should exist`);
      assert.equal(byNum[e.num].name, e.name, `CO #${e.num} name`);
      assert.equal(
        byNum[e.num].function_text,
        e.ft,
        `CO #${e.num} function_text`,
      );
      assert.equal(byNum[e.num].channel, e.ch, `CO #${e.num} channel`);
    }
  });

  it('LED dimmer channel A switching is linked to Chandelier On/Off and Status', () => {
    const co = parsed.comObjects.find(
      (co) => co.device_address === '1.1.3' && co.object_number === 7,
    );
    assert(co, 'dimmer channel A switching CO not found');
    assert.equal(co.name, 'Channel A: Switching');
    assert(
      co.ga_address.includes('1/0/0'),
      'should be linked to Chandelier On/Off',
    );
    assert(
      co.ga_address.includes('11/0/0'),
      'should be linked to Chandelier Status',
    );
  });

  it('push-button coupler (1.1.5) has exactly these 3 com objects', () => {
    const cos = parsed.comObjects.filter((co) => co.device_address === '1.1.5');
    assert.equal(cos.length, 3);
    const byNum = Object.fromEntries(cos.map((co) => [co.object_number, co]));

    assert(byNum[1], 'CO #1 should exist');
    assert.equal(byNum[1].name, 'S1.1: Travel');
    assert.equal(byNum[1].function_text, 'Input/Output');
    assert.equal(byNum[1].channel, 'Button pair 1-2 | button 1');

    assert(byNum[2], 'CO #2 should exist');
    assert.equal(byNum[2].name, 'S1.1: Adjust');
    assert.equal(byNum[2].function_text, 'Input/Output');
    assert.equal(byNum[2].channel, 'Button pair 1-2 | button 1');

    assert(byNum[16], 'CO #16 should exist');
    assert.equal(byNum[16].name, 'S2.1: Switching');
    assert.equal(byNum[16].function_text, 'Input/Output');
    assert.equal(byNum[16].channel, 'Button pair 3-4 | button 3');

    const nums = cos.map((co) => co.object_number).sort((a, b) => a - b);
    assert.deepEqual(nums, [1, 2, 16]);
  });

  it('US/U2.2 (1.1.4) has exactly these 2 com objects', () => {
    const cos = parsed.comObjects.filter((co) => co.device_address === '1.1.4');
    assert.equal(cos.length, 2);
    const byNum = Object.fromEntries(cos.map((co) => [co.object_number, co]));

    assert(byNum[0], 'CO #0 should exist');
    assert.equal(byNum[0].name, 'Input A');
    assert.equal(byNum[0].function_text, 'Disable');
    assert.equal(byNum[0].channel, 'Generic');

    assert(byNum[1], 'CO #1 should exist');
    assert.equal(byNum[1].name, 'Input A');
    assert.equal(byNum[1].function_text, 'Telegr. switch');
    assert.equal(byNum[1].channel, 'Generic');

    const nums = cos.map((co) => co.object_number).sort((a, b) => a - b);
    assert.deepEqual(nums, [0, 1]);
  });

  it('power supply (1.1.0) and USB interface (1.1.1) have no com objects', () => {
    assert.equal(
      parsed.comObjects.filter((co) => co.device_address === '1.1.0').length,
      0,
    );
    assert.equal(
      parsed.comObjects.filter((co) => co.device_address === '1.1.1').length,
      0,
    );
  });
});

// ── Parser: Topology ────────────────────────────────────────────────────────

describe('Smoke: topology', () => {
  it('extracts exactly 5 topology entries', () => {
    assert.equal(parsed.topologyEntries.length, 5);
  });

  it('has 2 areas (0 and 1)', () => {
    const areas = parsed.topologyEntries.filter((t) => t.line === null);
    assert.equal(areas.length, 2);
    assert(areas.some((a) => a.area === 0));
    assert(areas.some((a) => a.area === 1));
  });

  it('has 3 lines (0.0, 1.0, 1.1)', () => {
    const lines = parsed.topologyEntries.filter((t) => t.line !== null);
    assert.equal(lines.length, 3);
    assert(lines.some((l) => l.area === 0 && l.line === 0));
    assert(lines.some((l) => l.area === 1 && l.line === 0));
    assert(lines.some((l) => l.area === 1 && l.line === 1));
  });

  it('all devices are on area 1 line 1', () => {
    for (const d of parsed.devices) {
      assert.equal(d.area, 1, `${d.individual_address} area`);
      assert.equal(d.line, 1, `${d.individual_address} line`);
    }
  });
});

// ── Parser: Spaces (Building Structure) ─────────────────────────────────────

describe('Smoke: spaces', () => {
  it('extracts exactly 4 spaces', () => {
    assert.equal(parsed.spaces.length, 4);
  });

  it('building hierarchy: Smoke Test > Ground Floor > Kitchen > Cabinet', () => {
    const building = parsed.spaces.find((s) => s.type === 'Building');
    assert(building);
    assert.equal(building.name, 'Smoke Test');
    assert.equal(building.parent_idx, null);

    const floor = parsed.spaces.find((s) => s.type === 'Floor');
    assert(floor);
    assert.equal(floor.name, 'Ground Floor');
    assert.equal(floor.parent_idx, 0); // index of building

    const room = parsed.spaces.find((s) => s.type === 'Room');
    assert(room);
    assert.equal(room.name, 'Kitchen');
    assert.equal(room.parent_idx, 1); // index of floor

    const db = parsed.spaces.find((s) => s.type === 'DistributionBoard');
    assert(db);
    assert.equal(db.name, 'Cabinet');
    assert.equal(db.parent_idx, 2); // index of room
  });

  it('device-to-space assignments are correct', () => {
    // US/U2.2 and push-button are in Kitchen (index 2)
    assert.equal(parsed.devSpaceMap['1.1.4'], 2);
    assert.equal(parsed.devSpaceMap['1.1.5'], 2);
    // Power supply, USB, actuator, dimmer are in Cabinet (index 3)
    assert.equal(parsed.devSpaceMap['1.1.0'], 3);
    assert.equal(parsed.devSpaceMap['1.1.1'], 3);
    assert.equal(parsed.devSpaceMap['1.1.2'], 3);
    assert.equal(parsed.devSpaceMap['1.1.3'], 3);
  });
});

// ── Parser: Catalog ─────────────────────────────────────────────────────────

describe('Smoke: catalog', () => {
  it('extracts 12 catalog sections', () => {
    assert.equal(parsed.catalogSections.length, 12);
  });

  it('extracts 6 catalog items (one per device)', () => {
    assert.equal(parsed.catalogItems.length, 6);
  });

  it('all catalog items are from ABB', () => {
    for (const item of parsed.catalogItems) {
      assert.equal(item.manufacturer, 'ABB AG - STOTZ-KONTAKT');
      assert.equal(item.mfr_id, 'M-0002');
    }
  });

  it('catalog sections include expected categories', () => {
    const names = parsed.catalogSections.map((s) => s.number);
    assert(names.includes('POSU'), 'should have Power Supply section');
    assert(names.includes('STOU'), 'should have Standard Outputs section');
    assert(names.includes('LICO'), 'should have Lighting Control section');
    assert(names.includes('STIN'), 'should have Standard Inputs section');
    assert(names.includes('CEPB'), 'should have Push Button section');
  });

  it('catalog items have correct order numbers', () => {
    const orders = parsed.catalogItems.map((i) => i.order_number).sort();
    assert.deepEqual(orders, [
      '2CDG 110 144 R0011',
      '2CDG 110 243 R0011',
      '2CDG 110 244 R0011',
      '2CKA006197A0047',
      '6108/07-500',
      'GH Q631 0074 R0111',
    ]);
  });
});

// ── Parser: Param Models ────────────────────────────────────────────────────

describe('Smoke: param models', () => {
  it('extracts 7 application program models', () => {
    assert.equal(Object.keys(parsed.paramModels).length, 7);
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

  it('US/U2.2 model has 435 params and 8 load procedures', () => {
    const m = parsed.paramModels['M-0002_A-A002-13-2CF3'];
    assert(m, 'model not found');
    assert.equal(Object.keys(m.params).length, 435);
    assert.equal(m.loadProcedures.length, 8);
  });

  it('push-button coupler model has 924 params and 13 load procedures', () => {
    const m = parsed.paramModels['M-0002_A-0807-71-40F1-O0007'];
    assert(m, 'model not found');
    assert.equal(Object.keys(m.params).length, 924);
    assert.equal(m.loadProcedures.length, 13);
  });
});

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
    assert(data.error.startsWith('Parse failed:'));
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
