/**
 * Parameters in different AbsoluteSegments must not share a byte.
 *
 * An application program may declare several parameter-carrying segments,
 * and each numbers its offsets from zero. A parameter's offset therefore
 * only means something together with the segment it belongs to, which
 * <Memory CodeSegment="..." Offset="N"/> states and koolenex discarded
 * until 2026-09-12.
 *
 * The real case: M-0002_A-A001-13-63C2 declares AS-6D00 (160 bytes at
 * 0x6D00, four channels' worth of parameters at offsets 1..135) and
 * AS-6F00 (8 bytes at 0x6F00, the device-level General block at offsets
 * 0..4). 914 of its ParameterRefs name the first and 6 name the second.
 * Flattened into one buffer, General's five bytes landed on Channel A's,
 * and which value survived was decided by object iteration order - the
 * collision report from a real Verify:
 *
 *   0x0: P-2_R-2   then UP-30_R-36
 *   0x1: P-3_R-3   then UP-430_R-430
 *   0x2: UP-7_R-7  then UP-430_R-430
 *   0x3: UP-7_R-7  then UP-44_R-44
 *   0x4: P-6_R-436 then UP-44_R-44
 *
 * The fixture below is that shape in miniature: two segments, each with a
 * parameter at offset 1, holding different values.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveParamSegments,
  buildParamMemBySegment,
  buildParamMem,
  type DeviceModel,
} from '../server/routes/knx-tables.ts';

const CHANNELS = 0x6d00;
const GENERAL = 0x6f00;

/** Two segments, both numbering their own offsets from zero. */
const model = {
  absSegData: {
    [CHANNELS]: { size: 16, hex: '00'.repeat(16) },
    [GENERAL]: { size: 8, hex: '00'.repeat(8) },
  },
  paramMemLayout: {
    'chan-a': {
      offset: 1,
      bitOffset: 0,
      bitSize: 8,
      defaultValue: '22',
      segmentAddress: CHANNELS,
    },
    'chan-b': {
      offset: 2,
      bitOffset: 0,
      bitSize: 8,
      defaultValue: '99',
      segmentAddress: CHANNELS,
    },
    'general-a': {
      offset: 1,
      bitOffset: 0,
      bitSize: 8,
      defaultValue: '2',
      segmentAddress: GENERAL,
    },
  },
} as unknown as DeviceModel;

describe('resolveParamSegments', () => {
  it('reports each declared segment with the parameters that name it', () => {
    const segs = resolveParamSegments(model);
    assert.equal(segs.length, 2);
    assert.deepEqual(
      segs.map((s) => [s.address, s.size, s.keys.length]),
      [
        [CHANNELS, 16, 2],
        [GENERAL, 8, 1],
      ],
    );
  });

  it('returns nothing when the model records no segments', () => {
    // Every RelSegment device, and every app model cached before segments
    // were tracked. Callers fall back to the single-buffer path.
    const legacy = {
      absSegData: model.absSegData,
      paramMemLayout: {
        p: { offset: 1, bitOffset: 0, bitSize: 8, defaultValue: '5' },
      },
    } as unknown as DeviceModel;
    assert.deepEqual(resolveParamSegments(legacy), []);
  });

  it('ignores a segment the parameters name but the app never declared', () => {
    const bogus = {
      absSegData: {},
      paramMemLayout: model.paramMemLayout,
    } as unknown as DeviceModel;
    assert.deepEqual(resolveParamSegments(bogus), []);
  });
});

describe('buildParamMemBySegment', () => {
  it('gives each segment its own buffer, with only its own parameters', () => {
    const bufs = buildParamMemBySegment(model, {});
    assert.deepEqual([...bufs.keys()].sort(), [CHANNELS, GENERAL]);

    const chan = bufs.get(CHANNELS)!;
    assert.equal(chan.length, 16);
    assert.equal(chan[1], 22, "the channel segment's own byte 1");
    assert.equal(chan[2], 99);

    const general = bufs.get(GENERAL)!;
    assert.equal(general.length, 8);
    assert.equal(general[1], 2, "the general segment's own byte 1");
  });

  it('is what a single flat buffer gets wrong', () => {
    // Same layout through the single-buffer path: both parameters at
    // offset 1 write the same byte and the later one wins. This is the
    // behaviour being replaced, pinned so the difference is explicit.
    const flat = buildParamMem(16, model.paramMemLayout as never, {});
    assert.equal(
      flat[1],
      2,
      'one value is lost entirely - whichever iterated last',
    );
    assert.notEqual(
      flat[1],
      22,
      'and it is not the channel value, which is what the device holds',
    );
  });

  it('honours project values per segment', () => {
    const bufs = buildParamMemBySegment(model, {
      'chan-a': '7',
      'general-a': '9',
    });
    assert.equal(bufs.get(CHANNELS)![1], 7);
    assert.equal(bufs.get(GENERAL)![1], 9);
  });
});
