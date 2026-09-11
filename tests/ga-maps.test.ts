/**
 * shared/ga-maps.ts - the device<->GA lookup both sides render from.
 *
 * getProjectFull, GET /projects/:id/gas and three views all go through
 * this, and nothing tested it directly: every assertion on it so far has
 * been through something else, so a change here would surface as an odd
 * result several layers away.
 *
 * The shape it reads is the com_objects table's `ga_address`, which holds
 * whitespace-separated addresses because one com object can be linked to
 * several - that splitting, and the de-duplication either side of it, is
 * the whole of the logic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGAMaps } from '../shared/ga-maps.ts';

const co = (device_address: string, ga_address: string) => ({
  device_address,
  ga_address,
});

describe('buildGAMaps', () => {
  it('maps both directions', () => {
    const { deviceGAMap, gaDeviceMap } = buildGAMaps([co('1.1.1', '1/0/1')]);
    assert.deepEqual(deviceGAMap, { '1.1.1': ['1/0/1'] });
    assert.deepEqual(gaDeviceMap, { '1/0/1': ['1.1.1'] });
  });

  it('splits a com object linked to several GAs', () => {
    const { deviceGAMap, gaDeviceMap } = buildGAMaps([
      co('1.1.1', '1/0/1 1/0/2  1/0/3'),
    ]);
    assert.deepEqual(deviceGAMap['1.1.1'], ['1/0/1', '1/0/2', '1/0/3']);
    assert.deepEqual(Object.keys(gaDeviceMap), ['1/0/1', '1/0/2', '1/0/3']);
  });

  it('gathers every device on a shared GA', () => {
    // The normal case for a group address: one sender, several listeners.
    const { gaDeviceMap } = buildGAMaps([
      co('1.1.1', '1/0/1'),
      co('1.1.2', '1/0/1'),
      co('1.1.3', '1/0/1'),
    ]);
    assert.deepEqual(gaDeviceMap['1/0/1'], ['1.1.1', '1.1.2', '1.1.3']);
  });

  it('lists a device once per GA however many com objects link it', () => {
    // A device commonly has a send object and a receive object on the same
    // GA; it is still one device on that GA.
    const { deviceGAMap, gaDeviceMap } = buildGAMaps([
      co('1.1.1', '1/0/1'),
      co('1.1.1', '1/0/1'),
    ]);
    assert.deepEqual(deviceGAMap['1.1.1'], ['1/0/1']);
    assert.deepEqual(gaDeviceMap['1/0/1'], ['1.1.1']);
  });

  it('ignores a com object with no GA linked', () => {
    // Most com objects in a real project are unlinked.
    const { deviceGAMap, gaDeviceMap } = buildGAMaps([
      co('1.1.1', ''),
      co('1.1.2', '   '),
      co('1.1.3', '1/0/1'),
    ]);
    assert.deepEqual(Object.keys(deviceGAMap), ['1.1.3']);
    assert.deepEqual(gaDeviceMap['1/0/1'], ['1.1.3']);
  });

  it('tolerates a null ga_address', () => {
    // The column is nullable, and an import can leave it unset.
    const { deviceGAMap } = buildGAMaps([
      { device_address: '1.1.1', ga_address: null as unknown as string },
    ]);
    assert.deepEqual(deviceGAMap, {});
  });

  it('keeps the order the com objects came in', () => {
    // The routes order com objects by device then object number, and the
    // UI shows the lists as they are - so this is display order, not an
    // arbitrary one.
    const { deviceGAMap } = buildGAMaps([
      co('1.1.1', '9/0/9'),
      co('1.1.1', '1/0/1'),
    ]);
    assert.deepEqual(deviceGAMap['1.1.1'], ['9/0/9', '1/0/1']);
  });

  it('returns empty maps for no com objects', () => {
    assert.deepEqual(buildGAMaps([]), { deviceGAMap: {}, gaDeviceMap: {} });
  });
});
