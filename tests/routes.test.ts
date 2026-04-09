import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pinUrl, viewFromPath, pinKeyFromPath } from '../client/src/routes.ts';

// ── pinUrl ──────────────────────────────────────────────────────────────────

describe('pinUrl', () => {
  it('device', () => {
    assert.equal(pinUrl(3, 'device', '1.1.2'), '/projects/3/device/1.1.2');
  });

  it('ga', () => {
    assert.equal(pinUrl(3, 'ga', '0/0/1'), '/projects/3/ga/0/0/1');
  });

  it('compare', () => {
    assert.equal(
      pinUrl(3, 'compare', '1.1.2|1.1.3'),
      '/projects/3/compare/1.1.2/1.1.3',
    );
  });

  it('multicompare', () => {
    assert.equal(
      pinUrl(3, 'multicompare', '1.1.2|1.1.3|1.1.4'),
      '/projects/3/multicompare/1.1.2/1.1.3/1.1.4',
    );
  });

  it('manufacturer', () => {
    assert.equal(
      pinUrl(3, 'manufacturer', 'ABB AG'),
      '/projects/3/manufacturer/ABB%20AG',
    );
  });

  it('manufacturer with special chars', () => {
    assert.equal(
      pinUrl(3, 'manufacturer', 'ABB AG - STOTZ-KONTAKT'),
      '/projects/3/manufacturer/ABB%20AG%20-%20STOTZ-KONTAKT',
    );
  });

  it('model with slashes', () => {
    assert.equal(
      pinUrl(3, 'model', 'SA/S8.16.6.1'),
      '/projects/3/model/SA%2FS8.16.6.1',
    );
  });

  it('order_number', () => {
    assert.equal(
      pinUrl(3, 'order_number', '2CDG 110 244 R0011'),
      '/projects/3/order/2CDG%20110%20244%20R0011',
    );
  });

  it('space', () => {
    assert.equal(pinUrl(3, 'space', '42'), '/projects/3/space/42');
  });

  it('unknown wtype falls back to devices list', () => {
    assert.equal(pinUrl(3, 'unknown', 'foo'), '/projects/3/devices/foo');
  });
});

// ── viewFromPath ────────────────────────────────────────────────────────────

describe('viewFromPath', () => {
  it('root is projects', () => {
    assert.equal(viewFromPath('/'), 'projects');
  });

  it('settings', () => {
    assert.equal(viewFromPath('/settings'), 'settings');
  });

  it('project locations (default)', () => {
    assert.equal(viewFromPath('/projects/3'), 'locations');
    assert.equal(viewFromPath('/projects/3/'), 'locations');
    assert.equal(viewFromPath('/projects/3/locations'), 'locations');
  });

  it('list views', () => {
    assert.equal(viewFromPath('/projects/3/devices'), 'devices');
    assert.equal(viewFromPath('/projects/3/gas'), 'groups');
    assert.equal(viewFromPath('/projects/3/topology'), 'topology');
    assert.equal(viewFromPath('/projects/3/comobjects'), 'comobjects');
    assert.equal(viewFromPath('/projects/3/manufacturers'), 'manufacturers');
    assert.equal(viewFromPath('/projects/3/catalog'), 'catalog');
    assert.equal(viewFromPath('/projects/3/monitor'), 'monitor');
    assert.equal(viewFromPath('/projects/3/scan'), 'scan');
    assert.equal(viewFromPath('/projects/3/programming'), 'programming');
    assert.equal(viewFromPath('/projects/3/floorplan'), 'floorplan');
    assert.equal(viewFromPath('/projects/3/labels'), 'printlabels');
    assert.equal(viewFromPath('/projects/3/info'), 'project');
  });

  it('device detail is pin', () => {
    assert.equal(viewFromPath('/projects/3/device/1.1.2'), 'pin');
  });

  it('ga detail is pin', () => {
    assert.equal(viewFromPath('/projects/3/ga/0/0/1'), 'pin');
  });

  it('compare is pin', () => {
    assert.equal(viewFromPath('/projects/3/compare/1.1.2/1.1.3'), 'pin');
  });

  it('multicompare is pin', () => {
    assert.equal(
      viewFromPath('/projects/3/multicompare/1.1.2/1.1.3/1.1.4'),
      'pin',
    );
  });

  it('manufacturer/model/order/space are pin', () => {
    assert.equal(viewFromPath('/projects/3/manufacturer/ABB%20AG'), 'pin');
    assert.equal(viewFromPath('/projects/3/model/SA%2FS8'), 'pin');
    assert.equal(viewFromPath('/projects/3/order/2CDG'), 'pin');
    assert.equal(viewFromPath('/projects/3/space/42'), 'pin');
  });

  it('unknown segment defaults to locations', () => {
    assert.equal(viewFromPath('/projects/3/nonexistent'), 'locations');
  });

  it('non-project path defaults to projects', () => {
    assert.equal(viewFromPath('/random/path'), 'projects');
  });
});

// ── pinKeyFromPath ──────────────────────────────────────────────────────────

describe('pinKeyFromPath', () => {
  it('non-project path returns null', () => {
    assert.equal(pinKeyFromPath('/'), null);
    assert.equal(pinKeyFromPath('/settings'), null);
  });

  it('list view returns null', () => {
    assert.equal(pinKeyFromPath('/projects/3/devices'), null);
    assert.equal(pinKeyFromPath('/projects/3/gas'), null);
  });

  it('device detail', () => {
    assert.equal(pinKeyFromPath('/projects/3/device/1.1.2'), 'device:1.1.2');
  });

  it('ga detail', () => {
    assert.equal(pinKeyFromPath('/projects/3/ga/0/0/1'), 'ga:0/0/1');
    assert.equal(pinKeyFromPath('/projects/3/ga/11/0/0'), 'ga:11/0/0');
  });

  it('compare', () => {
    assert.equal(
      pinKeyFromPath('/projects/3/compare/1.1.2/1.1.3'),
      'compare:1.1.2|1.1.3',
    );
  });

  it('multicompare', () => {
    assert.equal(
      pinKeyFromPath('/projects/3/multicompare/1.1.2/1.1.3/1.1.4'),
      'multicompare:1.1.2|1.1.3|1.1.4',
    );
  });

  it('manufacturer', () => {
    assert.equal(
      pinKeyFromPath('/projects/3/manufacturer/ABB%20AG'),
      'manufacturer:ABB AG',
    );
  });

  it('model with encoded slash', () => {
    assert.equal(
      pinKeyFromPath('/projects/3/model/SA%2FS8.16.6.1'),
      'model:SA/S8.16.6.1',
    );
  });

  it('order_number', () => {
    assert.equal(
      pinKeyFromPath('/projects/3/order/2CDG%20110'),
      'order_number:2CDG 110',
    );
  });

  it('space', () => {
    assert.equal(pinKeyFromPath('/projects/3/space/42'), 'space:42');
  });

  it('roundtrip: pinUrl → pinKeyFromPath recovers the original key', () => {
    const cases: Array<[string, string]> = [
      ['device', '1.1.2'],
      ['ga', '0/0/1'],
      ['compare', '1.1.2|1.1.3'],
      ['multicompare', '1.1.2|1.1.3|1.1.4'],
      ['manufacturer', 'ABB AG - STOTZ-KONTAKT'],
      ['model', 'SA/S8.16.6.1'],
      ['order_number', '2CDG 110 244 R0011'],
      ['space', '42'],
    ];
    for (const [wtype, address] of cases) {
      const url = pinUrl(3, wtype, address);
      const key = pinKeyFromPath(url);
      assert.equal(
        key,
        `${wtype}:${address}`,
        `roundtrip failed for ${wtype}:${address} via ${url}`,
      );
    }
  });
});
