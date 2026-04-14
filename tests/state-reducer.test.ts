/**
 * Tests for the client-side state reducer (client/src/state.ts).
 * The reducer is a pure function — same input, same output — so we can
 * test it without React, a browser, or rendering anything.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState, type AppState } from '../client/src/state.ts';
import type {
  ProjectFull,
  Device,
  EnrichedGA,
  ComObjectWithDevice,
  Space,
  Topology,
} from '../shared/types.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal ProjectFull with empty arrays for testing. */
function emptyProjectData(overrides?: Partial<ProjectFull>): ProjectFull {
  return {
    project: {
      id: 1,
      name: 'Test',
      file_name: null,
      created_at: '',
      updated_at: '',
      thumbnail: '',
      project_info: '',
    },
    devices: [],
    gas: [],
    comObjects: [],
    deviceGAMap: {},
    gaDeviceMap: {},
    spaces: [],
    topology: [],
    ...overrides,
  };
}

function device(id: number, overrides?: Partial<Device>): Device {
  return {
    id,
    project_id: 1,
    individual_address: `1.1.${id}`,
    name: `Device ${id}`,
    description: '',
    comment: '',
    order_number: '',
    serial_number: '',
    manufacturer: '',
    model: '',
    product_ref: '',
    area: 1,
    line: 1,
    area_name: '',
    line_name: '',
    medium: 'TP',
    device_type: 'actuator',
    status: 'unassigned',
    last_modified: '',
    last_download: '',
    app_number: '',
    app_version: '',
    app_ref: '',
    parameters: '[]',
    param_values: '{}',
    space_id: null,
    model_translations: '',
    bus_current: 0,
    width_mm: 0,
    is_power_supply: 0,
    is_coupler: 0,
    is_rail_mounted: 0,
    installation_hints: '',
    floor_x: 0,
    floor_y: 0,
    ...overrides,
  };
}

function ga(
  id: number,
  main_g: number,
  middle_g: number,
  sub_g: number,
  overrides?: Partial<EnrichedGA>,
): EnrichedGA {
  return {
    id,
    project_id: 1,
    address: `${main_g}/${middle_g}/${sub_g}`,
    name: `GA ${id}`,
    dpt: '',
    main_g,
    middle_g,
    sub_g,
    comment: '',
    description: '',
    main_group_name: '',
    middle_group_name: '',
    devices: [],
    ...overrides,
  };
}

function comObject(
  id: number,
  device_address: string,
  ga_address: string,
  overrides?: Partial<ComObjectWithDevice>,
): ComObjectWithDevice {
  return {
    id,
    project_id: 1,
    device_id: 1,
    object_number: 0,
    channel: '',
    name: '',
    function_text: '',
    dpt: '',
    object_size: '',
    flags: '',
    direction: 'both',
    ga_address,
    ga_send: '',
    ga_receive: '',
    device_address,
    device_name: '',
    ...overrides,
  };
}

function space(id: number, overrides?: Partial<Space>): Space {
  return {
    id,
    project_id: 1,
    name: `Space ${id}`,
    type: 'Room',
    parent_id: null,
    sort_order: 0,
    usage_id: '',
    ...overrides,
  };
}

function topo(id: number, area: number, line: number | null): Topology {
  return { id, project_id: 1, area, line, name: '', medium: 'TP' };
}

function stateWith(projectData: ProjectFull): AppState {
  return { ...initialState, projectData };
}

// ── Simple setters ───────────────────────────────────────────────────────────

describe('reducer: simple setters', () => {
  it('SET_PROJECTS replaces projects array', () => {
    const projects = [
      {
        id: 1,
        name: 'P1',
        file_name: null,
        created_at: '',
        updated_at: '',
        thumbnail: '',
        project_info: '',
      },
    ];
    const s = reducer(initialState, { type: 'SET_PROJECTS', projects });
    assert.deepEqual(s.projects, projects);
  });

  it('SET_BUS replaces bus status', () => {
    const status = { connected: true, host: '192.168.1.1', hasLib: true };
    const s = reducer(initialState, { type: 'SET_BUS', status });
    assert.deepEqual(s.busStatus, status);
  });

  it('SET_LOADING sets loading flag', () => {
    const s = reducer(initialState, { type: 'SET_LOADING', loading: true });
    assert.equal(s.loading, true);
  });

  it('SET_ERROR sets error message', () => {
    const s = reducer(initialState, { type: 'SET_ERROR', error: 'bad' });
    assert.equal(s.error, 'bad');
  });

  it('SET_ERROR clears error with null', () => {
    const s1 = reducer(initialState, { type: 'SET_ERROR', error: 'bad' });
    const s2 = reducer(s1, { type: 'SET_ERROR', error: null });
    assert.equal(s2.error, null);
  });

  it('SET_TELEGRAMS replaces telegram array', () => {
    const telegrams = [
      {
        id: 1,
        project_id: null,
        timestamp: '',
        src: null,
        dst: null,
        type: null,
        raw_value: null,
        decoded: null,
        priority: 'low',
      },
    ];
    const s = reducer(initialState, { type: 'SET_TELEGRAMS', telegrams });
    assert.deepEqual(s.telegrams, telegrams);
  });

  it('DPT_LOADED returns new state reference', () => {
    const s = reducer(initialState, { type: 'DPT_LOADED' });
    assert.notEqual(s, initialState);
    assert.deepEqual(s, initialState);
  });
});

// ── ADD_TELEGRAM ─────────────────────────────────────────────────────────────

describe('reducer: ADD_TELEGRAM', () => {
  const mkTelegram = (id: number) => ({
    id,
    project_id: null,
    timestamp: '',
    src: null,
    dst: null,
    type: null,
    raw_value: null,
    decoded: null,
    priority: 'low',
  });

  it('prepends telegram', () => {
    const s1 = reducer(initialState, {
      type: 'ADD_TELEGRAM',
      telegram: mkTelegram(1),
    });
    const s2 = reducer(s1, { type: 'ADD_TELEGRAM', telegram: mkTelegram(2) });
    assert.equal(s2.telegrams.length, 2);
    assert.equal(s2.telegrams[0].id, 2); // most recent first
    assert.equal(s2.telegrams[1].id, 1);
  });

  it('caps at 500 telegrams', () => {
    let s = initialState;
    for (let i = 0; i < 510; i++) {
      s = reducer(s, { type: 'ADD_TELEGRAM', telegram: mkTelegram(i) });
    }
    assert.equal(s.telegrams.length, 500);
    assert.equal(s.telegrams[0].id, 509); // newest
  });
});

// ── OPEN_WINDOW / CLOSE_WINDOW ──────────────────────────────────────────────

describe('reducer: window management', () => {
  it('OPEN_WINDOW adds a window', () => {
    const s = reducer(initialState, {
      type: 'OPEN_WINDOW',
      wtype: 'device',
      address: '1.1.1',
    });
    assert.equal(s.windows.length, 1);
    assert.equal(s.windows[0].key, 'device:1.1.1');
    assert.equal(s.windows[0].wtype, 'device');
    assert.equal(s.windows[0].address, '1.1.1');
  });

  it('OPEN_WINDOW deduplicates by key', () => {
    const s1 = reducer(initialState, {
      type: 'OPEN_WINDOW',
      wtype: 'device',
      address: '1.1.1',
    });
    const s2 = reducer(s1, {
      type: 'OPEN_WINDOW',
      wtype: 'device',
      address: '1.1.1',
    });
    assert.equal(s2.windows.length, 1);
    assert.equal(s2.windows, s1.windows); // same reference — no change
  });

  it('OPEN_WINDOW allows different types for same address', () => {
    const s1 = reducer(initialState, {
      type: 'OPEN_WINDOW',
      wtype: 'device',
      address: '1.1.1',
    });
    const s2 = reducer(s1, {
      type: 'OPEN_WINDOW',
      wtype: 'ga',
      address: '1.1.1',
    });
    assert.equal(s2.windows.length, 2);
  });

  it('CLOSE_WINDOW removes by key', () => {
    const s1 = reducer(initialState, {
      type: 'OPEN_WINDOW',
      wtype: 'device',
      address: '1.1.1',
    });
    const s2 = reducer(s1, {
      type: 'OPEN_WINDOW',
      wtype: 'ga',
      address: '1/0/0',
    });
    const s3 = reducer(s2, { type: 'CLOSE_WINDOW', key: 'device:1.1.1' });
    assert.equal(s3.windows.length, 1);
    assert.equal(s3.windows[0].key, 'ga:1/0/0');
  });

  it('CLOSE_WINDOW with non-existent key is a no-op', () => {
    const s = reducer(initialState, { type: 'CLOSE_WINDOW', key: 'nope' });
    assert.deepEqual(s.windows, []);
  });
});

// ── SET_ACTIVE ──────────────────────────────────────────────────────────────

describe('reducer: SET_ACTIVE', () => {
  it('sets active project and project data', () => {
    const data = emptyProjectData();
    const s = reducer(initialState, { type: 'SET_ACTIVE', id: 42, data });
    assert.equal(s.activeProjectId, 42);
    assert.equal(s.projectData, data);
  });
});

// ── Patch actions with null projectData ──────────────────────────────────────

describe('reducer: null projectData guards', () => {
  const actions = [
    { type: 'PATCH_DEVICE' as const, id: 1, patch: { name: 'x' } },
    { type: 'PATCH_GA' as const, id: 1, patch: { name: 'x' } },
    { type: 'PATCH_SPACE' as const, id: 1, patch: { name: 'x' } },
    { type: 'PATCH_TOPOLOGY' as const, id: 1, patch: { name: 'x' } },
    {
      type: 'SET_DEVICE_STATUS' as const,
      deviceId: 1,
      status: 'programmed' as const,
    },
    { type: 'DELETE_GA' as const, id: 1 },
    { type: 'DELETE_DEVICE' as const, id: 1 },
    { type: 'DELETE_SPACE' as const, id: 1, newParentId: null },
    { type: 'DELETE_TOPOLOGY' as const, id: 1 },
    { type: 'ADD_GA' as const, ga: ga(1, 0, 0, 1) },
    { type: 'ADD_DEVICE' as const, device: device(1) },
    { type: 'ADD_SPACE' as const, space: space(1) },
    { type: 'ADD_TOPOLOGY' as const, entry: topo(1, 1, null) },
    {
      type: 'RENAME_GA_GROUP' as const,
      field: 'main_group_name' as const,
      main_g: 0,
      name: 'x',
    },
    { type: 'PATCH_COMOBJECT' as const, id: 1, patch: {} },
  ];

  for (const action of actions) {
    it(`${action.type} returns state unchanged when projectData is null`, () => {
      const s = reducer(initialState, action);
      assert.equal(s, initialState);
    });
  }
});

// ── PATCH_DEVICE ────────────────────────────────────────────────────────────

describe('reducer: PATCH_DEVICE', () => {
  it('patches matching device by id', () => {
    const s = stateWith(
      emptyProjectData({
        devices: [device(1, { name: 'Old' }), device(2, { name: 'Other' })],
      }),
    );
    const s2 = reducer(s, {
      type: 'PATCH_DEVICE',
      id: 1,
      patch: { name: 'New' },
    });
    assert.equal(s2.projectData!.devices[0].name, 'New');
    assert.equal(s2.projectData!.devices[1].name, 'Other'); // untouched
  });

  it('leaves state unchanged for non-existent id', () => {
    const s = stateWith(emptyProjectData({ devices: [device(1)] }));
    const s2 = reducer(s, {
      type: 'PATCH_DEVICE',
      id: 999,
      patch: { name: 'X' },
    });
    assert.equal(s2.projectData!.devices[0].name, 'Device 1');
  });
});

// ── PATCH_GA ────────────────────────────────────────────────────────────────

describe('reducer: PATCH_GA', () => {
  it('patches matching GA by id', () => {
    const s = stateWith(
      emptyProjectData({
        gas: [ga(1, 0, 0, 1, { name: 'Old' }), ga(2, 0, 0, 2)],
      }),
    );
    const s2 = reducer(s, { type: 'PATCH_GA', id: 1, patch: { name: 'New' } });
    assert.equal(s2.projectData!.gas[0].name, 'New');
    assert.equal(s2.projectData!.gas[1].name, 'GA 2');
  });
});

// ── RENAME_GA_GROUP ─────────────────────────────────────────────────────────

describe('reducer: RENAME_GA_GROUP', () => {
  it('renames main group on all matching GAs', () => {
    const s = stateWith(
      emptyProjectData({
        gas: [
          ga(1, 1, 0, 0),
          ga(2, 1, 0, 1),
          ga(3, 2, 0, 0), // different main_g
        ],
      }),
    );
    const s2 = reducer(s, {
      type: 'RENAME_GA_GROUP',
      field: 'main_group_name',
      main_g: 1,
      name: 'Lighting',
    });
    assert.equal(s2.projectData!.gas[0].main_group_name, 'Lighting');
    assert.equal(s2.projectData!.gas[1].main_group_name, 'Lighting');
    assert.equal(s2.projectData!.gas[2].main_group_name, ''); // unchanged
  });

  it('renames middle group on matching main_g and middle_g', () => {
    const s = stateWith(
      emptyProjectData({
        gas: [ga(1, 1, 0, 0), ga(2, 1, 1, 0), ga(3, 1, 0, 1)],
      }),
    );
    const s2 = reducer(s, {
      type: 'RENAME_GA_GROUP',
      field: 'middle_group_name',
      main_g: 1,
      middle_g: 0,
      name: 'Switching',
    });
    assert.equal(s2.projectData!.gas[0].middle_group_name, 'Switching');
    assert.equal(s2.projectData!.gas[1].middle_group_name, ''); // different middle_g
    assert.equal(s2.projectData!.gas[2].middle_group_name, 'Switching');
  });
});

// ── SET_DEVICE_STATUS ───────────────────────────────────────────────────────

describe('reducer: SET_DEVICE_STATUS', () => {
  it('sets status on matching device', () => {
    const s = stateWith(
      emptyProjectData({
        devices: [device(1, { status: 'unassigned' }), device(2)],
      }),
    );
    const s2 = reducer(s, {
      type: 'SET_DEVICE_STATUS',
      deviceId: 1,
      status: 'programmed',
    });
    assert.equal(s2.projectData!.devices[0].status, 'programmed');
    assert.equal(s2.projectData!.devices[1].status, 'unassigned'); // untouched
  });
});

// ── ADD_GA ────────────────────────────────────────────────────────────────────

describe('reducer: ADD_GA', () => {
  it('adds GA and sorts by main_g, middle_g, sub_g', () => {
    const s = stateWith(
      emptyProjectData({
        gas: [ga(1, 1, 0, 0), ga(2, 2, 0, 0)],
      }),
    );
    // Insert GA 1/0/5 — should go between existing GAs
    const s2 = reducer(s, {
      type: 'ADD_GA',
      ga: ga(3, 1, 0, 5),
    });
    assert.equal(s2.projectData!.gas.length, 3);
    assert.equal(s2.projectData!.gas[0].address, '1/0/0');
    assert.equal(s2.projectData!.gas[1].address, '1/0/5');
    assert.equal(s2.projectData!.gas[2].address, '2/0/0');
  });

  it('sorts correctly when middle_g differs', () => {
    const s = stateWith(emptyProjectData({ gas: [] }));
    let s2 = reducer(s, { type: 'ADD_GA', ga: ga(1, 1, 2, 0) });
    s2 = reducer(s2, { type: 'ADD_GA', ga: ga(2, 1, 0, 0) });
    s2 = reducer(s2, { type: 'ADD_GA', ga: ga(3, 1, 1, 0) });

    assert.equal(s2.projectData!.gas[0].address, '1/0/0');
    assert.equal(s2.projectData!.gas[1].address, '1/1/0');
    assert.equal(s2.projectData!.gas[2].address, '1/2/0');
  });

  it('initializes devices to empty array', () => {
    const s = stateWith(emptyProjectData());
    const s2 = reducer(s, {
      type: 'ADD_GA',
      ga: ga(1, 1, 0, 0, { devices: ['1.1.1'] }),
    });
    // ADD_GA always sets devices to []
    assert.deepEqual(s2.projectData!.gas[0].devices, []);
  });
});

// ── DELETE_GA ────────────────────────────────────────────────────────────────

describe('reducer: DELETE_GA', () => {
  it('removes GA by id', () => {
    const s = stateWith(
      emptyProjectData({
        gas: [ga(1, 0, 0, 1), ga(2, 0, 0, 2)],
      }),
    );
    const s2 = reducer(s, { type: 'DELETE_GA', id: 1 });
    assert.equal(s2.projectData!.gas.length, 1);
    assert.equal(s2.projectData!.gas[0].id, 2);
  });
});

// ── ADD_DEVICE / DELETE_DEVICE ──────────────────────────────────────────────

describe('reducer: ADD_DEVICE / DELETE_DEVICE', () => {
  it('ADD_DEVICE appends device', () => {
    const s = stateWith(emptyProjectData({ devices: [device(1)] }));
    const s2 = reducer(s, { type: 'ADD_DEVICE', device: device(2) });
    assert.equal(s2.projectData!.devices.length, 2);
    assert.equal(s2.projectData!.devices[1].id, 2);
  });

  it('DELETE_DEVICE removes by id', () => {
    const s = stateWith(
      emptyProjectData({
        devices: [device(1), device(2)],
      }),
    );
    const s2 = reducer(s, { type: 'DELETE_DEVICE', id: 1 });
    assert.equal(s2.projectData!.devices.length, 1);
    assert.equal(s2.projectData!.devices[0].id, 2);
  });
});

// ── PATCH_SPACE / ADD_SPACE / DELETE_SPACE ───────────────────────────────────

describe('reducer: space operations', () => {
  it('PATCH_SPACE patches matching space', () => {
    const s = stateWith(
      emptyProjectData({
        spaces: [space(1, { name: 'Old' })],
      }),
    );
    const s2 = reducer(s, {
      type: 'PATCH_SPACE',
      id: 1,
      patch: { name: 'New' },
    });
    assert.equal(s2.projectData!.spaces[0].name, 'New');
  });

  it('ADD_SPACE appends space', () => {
    const s = stateWith(emptyProjectData());
    const s2 = reducer(s, { type: 'ADD_SPACE', space: space(1) });
    assert.equal(s2.projectData!.spaces.length, 1);
  });

  it('DELETE_SPACE removes space and reparents children', () => {
    const s = stateWith(
      emptyProjectData({
        spaces: [
          space(1), // parent
          space(2, { parent_id: 1 }), // child of 1
          space(3, { parent_id: 1 }), // child of 1
          space(4, { parent_id: 2 }), // grandchild — not directly reparented
        ],
        devices: [device(10, { space_id: 1 }), device(11, { space_id: 2 })],
      }),
    );

    const s2 = reducer(s, { type: 'DELETE_SPACE', id: 1, newParentId: null });

    // Space 1 removed
    assert.equal(s2.projectData!.spaces.length, 3);
    assert.ok(!s2.projectData!.spaces.find((s) => s.id === 1));

    // Children of space 1 reparented to null
    assert.equal(
      s2.projectData!.spaces.find((s) => s.id === 2)!.parent_id,
      null,
    );
    assert.equal(
      s2.projectData!.spaces.find((s) => s.id === 3)!.parent_id,
      null,
    );

    // Grandchild unchanged
    assert.equal(s2.projectData!.spaces.find((s) => s.id === 4)!.parent_id, 2);

    // Device in deleted space has space_id nulled
    assert.equal(
      s2.projectData!.devices.find((d) => d.id === 10)!.space_id,
      null,
    );
    // Device in child space unchanged
    assert.equal(s2.projectData!.devices.find((d) => d.id === 11)!.space_id, 2);
  });

  it('DELETE_SPACE reparents to a specific parent', () => {
    const s = stateWith(
      emptyProjectData({
        spaces: [space(1), space(2), space(3, { parent_id: 1 })],
        devices: [],
      }),
    );
    const s2 = reducer(s, { type: 'DELETE_SPACE', id: 1, newParentId: 2 });
    assert.equal(s2.projectData!.spaces.find((s) => s.id === 3)!.parent_id, 2);
  });
});

// ── Topology operations ─────────────────────────────────────────────────────

describe('reducer: topology operations', () => {
  it('ADD_TOPOLOGY appends', () => {
    const s = stateWith(emptyProjectData());
    const s2 = reducer(s, { type: 'ADD_TOPOLOGY', entry: topo(1, 1, null) });
    assert.equal(s2.projectData!.topology.length, 1);
  });

  it('PATCH_TOPOLOGY patches by id', () => {
    const s = stateWith(
      emptyProjectData({
        topology: [topo(1, 1, null)],
      }),
    );
    const s2 = reducer(s, {
      type: 'PATCH_TOPOLOGY',
      id: 1,
      patch: { name: 'Area 1' },
    });
    assert.equal(s2.projectData!.topology[0].name, 'Area 1');
  });

  it('DELETE_TOPOLOGY removes by id', () => {
    const s = stateWith(
      emptyProjectData({
        topology: [topo(1, 1, null), topo(2, 2, null)],
      }),
    );
    const s2 = reducer(s, { type: 'DELETE_TOPOLOGY', id: 1 });
    assert.equal(s2.projectData!.topology.length, 1);
    assert.equal(s2.projectData!.topology[0].id, 2);
  });

  it('handles null topology array', () => {
    const pd = emptyProjectData();
    (pd as any).topology = null;
    const s = stateWith(pd);

    const s2 = reducer(s, { type: 'ADD_TOPOLOGY', entry: topo(1, 1, null) });
    assert.equal(s2.projectData!.topology.length, 1);

    const s3 = reducer(s, {
      type: 'PATCH_TOPOLOGY',
      id: 1,
      patch: { name: 'X' },
    });
    assert.deepEqual(s3.projectData!.topology, []);

    const s4 = reducer(s, { type: 'DELETE_TOPOLOGY', id: 1 });
    assert.deepEqual(s4.projectData!.topology, []);
  });
});

// ── PATCH_COMOBJECT ─────────────────────────────────────────────────────────

describe('reducer: PATCH_COMOBJECT', () => {
  it('patches com object and rebuilds GA maps', () => {
    const co1 = comObject(10, '1.1.1', '1/0/0');
    const s = stateWith(
      emptyProjectData({
        comObjects: [co1],
        gas: [ga(1, 1, 0, 0)],
      }),
    );

    const s2 = reducer(s, {
      type: 'PATCH_COMOBJECT',
      id: 10,
      patch: { ga_address: '1/0/0' },
    });

    // GA maps rebuilt
    assert.deepEqual(s2.projectData!.deviceGAMap['1.1.1'], ['1/0/0']);
    assert.deepEqual(s2.projectData!.gaDeviceMap['1/0/0'], ['1.1.1']);

    // GA device list updated
    assert.deepEqual(s2.projectData!.gas[0].devices, ['1.1.1']);
  });

  it('clears GA maps when ga_address removed', () => {
    const co1 = comObject(10, '1.1.1', '1/0/0');
    const s = stateWith(
      emptyProjectData({
        comObjects: [co1],
        gas: [ga(1, 1, 0, 0)],
      }),
    );

    const s2 = reducer(s, {
      type: 'PATCH_COMOBJECT',
      id: 10,
      patch: { ga_address: '' },
    });

    assert.deepEqual(s2.projectData!.deviceGAMap, {});
    assert.deepEqual(s2.projectData!.gaDeviceMap, {});
    assert.deepEqual(s2.projectData!.gas[0].devices, []);
  });

  it('handles multiple com objects for same device', () => {
    const s = stateWith(
      emptyProjectData({
        comObjects: [
          comObject(10, '1.1.1', '1/0/0'),
          comObject(11, '1.1.1', '1/0/1'),
        ],
        gas: [ga(1, 1, 0, 0), ga(2, 1, 0, 1)],
      }),
    );

    // Patch co 11 to also point to 1/0/0
    const s2 = reducer(s, {
      type: 'PATCH_COMOBJECT',
      id: 11,
      patch: { ga_address: '1/0/0' },
    });

    // Device 1.1.1 maps to 1/0/0 (from both com objects, but deduplicated)
    assert.deepEqual(s2.projectData!.deviceGAMap['1.1.1'], ['1/0/0']);
    assert.deepEqual(s2.projectData!.gas[0].devices, ['1.1.1']);
    // 1/0/1 has no devices now
    assert.deepEqual(s2.projectData!.gas[1].devices, []);
  });
});

// ── PATCH_PROJECT ───────────────────────────────────────────────────────────

describe('reducer: PATCH_PROJECT', () => {
  it('keeps projectData null when projectData is null', () => {
    const s = reducer(initialState, {
      type: 'PATCH_PROJECT',
      patch: { devices: [] },
    });
    assert.equal(s.projectData, null);
  });

  it('shallow merges into projectData', () => {
    const s = stateWith(
      emptyProjectData({
        devices: [device(1)],
      }),
    );
    const newDevices = [device(1, { name: 'Changed' }), device(2)];
    const s2 = reducer(s, {
      type: 'PATCH_PROJECT',
      patch: { devices: newDevices },
    });
    assert.equal(s2.projectData!.devices.length, 2);
    assert.equal(s2.projectData!.devices[0].name, 'Changed');
  });
});

// ── Scan state ──────────────────────────────────────────────────────────────

describe('reducer: scan state', () => {
  it('SCAN_PROGRESS accumulates reachable results', () => {
    let s = reducer(initialState, {
      type: 'SCAN_PROGRESS',
      progress: { address: '1.1.0', reachable: false, done: 1, total: 256 },
    });
    assert.equal(s.scan.running, true);
    assert.equal(s.scan.results.length, 0); // not reachable

    s = reducer(s, {
      type: 'SCAN_PROGRESS',
      progress: {
        address: '1.1.1',
        reachable: true,
        descriptor: '07b0',
        done: 2,
        total: 256,
      },
    });
    assert.equal(s.scan.results.length, 1);
    assert.equal(s.scan.results[0].address, '1.1.1');
    assert.equal(s.scan.results[0].descriptor, '07b0');
  });

  it('SCAN_DONE sets final results and stops running', () => {
    const s = reducer(initialState, {
      type: 'SCAN_DONE',
      results: [{ address: '1.1.1', descriptor: '07b0' }],
    });
    assert.equal(s.scan.running, false);
    assert.equal(s.scan.progress, null);
    assert.equal(s.scan.results.length, 1);
  });

  it('SCAN_RESET clears everything', () => {
    let s = reducer(initialState, {
      type: 'SCAN_PROGRESS',
      progress: {
        address: '1.1.1',
        reachable: true,
        descriptor: '07b0',
        done: 1,
        total: 256,
      },
    });
    s = reducer(s, { type: 'SCAN_RESET' });
    assert.deepEqual(s.scan, { results: [], running: false, progress: null });
  });
});

// ── Default case ────────────────────────────────────────────────────────────

describe('reducer: default case', () => {
  it('returns state unchanged for unknown action', () => {
    const s = reducer(initialState, { type: 'UNKNOWN' } as any);
    assert.equal(s, initialState);
  });
});
