/**
 * KnxLoopbackConnection: an in-memory transport for driving a full
 * downloadDevice() run with no socket and no device. It records every
 * outgoing frame, captures each memory write (attributed to the interface
 * object whose table base it falls under) and synthesises the responses the
 * real orchestration waits for.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KnxLoopbackConnection } from '../server/knx-loopback-connection.ts';
import type { LoopbackDeviceConfig } from '../server/knx-loopback-connection.ts';
import type { DownloadStep } from '../server/knx-connection.ts';

const ADDR = '1.1.9';
const PARAM_BASE = 0x5f0e;

function config(
  over: Partial<LoopbackDeviceConfig> = {},
): LoopbackDeviceConfig {
  return {
    deviceAddr: ADDR,
    mask: 0x07b0,
    serial: '00c50011aabb',
    tableBases: { 4: PARAM_BASE },
    ...over,
  };
}

const steps: DownloadStep[] = [
  {
    type: 'RelSegment',
    objIdx: 0,
    propId: 0,
    lsmIdx: 4,
    size: 20,
    mode: 'full',
    fill: 255,
  },
  {
    type: 'RelSegment',
    objIdx: 0,
    propId: 0,
    lsmIdx: 4,
    size: 20,
    mode: 'par',
    fill: 255,
  },
  { type: 'WriteRelMem', objIdx: 4, propId: 0, size: 20, offset: 0 },
];
const payload = Buffer.from(Array.from({ length: 20 }, (_, i) => i + 1));

describe('KnxLoopbackConnection', () => {
  it('starts connected with the default local address and no recorded traffic', () => {
    const conn = new KnxLoopbackConnection(config());
    assert.equal(conn.connected, true);
    assert.equal(conn.localAddr, '1.0.1');
    assert.equal(conn.frames.length, 0);
    assert.equal(conn.memoryWrites.length, 0);
    assert.equal(
      new KnxLoopbackConnection(config({ localAddr: '1.0.7' })).localAddr,
      '1.0.7',
    );
  });

  it('runs a whole short download without a socket and captures the parameter write', async () => {
    const conn = new KnxLoopbackConnection(config());
    const result = await conn.downloadDevice(
      ADDR,
      steps,
      null,
      null,
      payload,
      undefined,
      {
        resolvedBases: { 4: PARAM_BASE },
        mode: 'full',
      },
    );
    assert.ok(result, 'downloadDevice resolves with a result');

    // Every memory write the orchestration made was recorded, attributed to the
    // parameter object (4) through its table base, and carries the payload.
    assert.ok(conn.memoryWrites.length >= 1);
    const written = Buffer.concat(
      conn.memoryWrites
        .slice()
        .sort((a, b) => a.address - b.address)
        .map((w) => w.data),
    );
    assert.deepEqual([...written], [...payload]);
    for (const w of conn.memoryWrites) {
      assert.equal(w.objIdx, 4);
      assert.ok(
        w.address >= PARAM_BASE && w.address < PARAM_BASE + payload.length,
      );
    }
    assert.equal(conn.memoryWrites[0]!.address, PARAM_BASE);
  });

  it('records outgoing frames and the synthesised device responses in order', async () => {
    const conn = new KnxLoopbackConnection(config());
    await conn.downloadDevice(ADDR, steps, null, null, payload, undefined, {
      resolvedBases: { 4: PARAM_BASE },
      mode: 'full',
    });
    const out = conn.frames.filter((f) => f.direction === 'out');
    const inn = conn.frames.filter((f) => f.direction === 'in');
    assert.ok(out.length > 0 && inn.length > 0);
    // Outgoing frames are addressed to the device from the loopback's own address.
    for (const f of out) {
      assert.ok(f.parsed);
      assert.equal(f.parsed!.src, '1.0.1');
    }
    // The mask read is answered with the configured System B mask.
    const idx = out.findIndex(
      (f) => f.parsed?.apciName === 'DeviceDescriptor_Read',
    );
    assert.ok(idx >= 0, 'a DeviceDescriptor_Read was sent');
    const resp = inn.find(
      (f) => f.parsed?.apciName === 'DeviceDescriptor_Response',
    );
    assert.ok(resp, 'the read was answered');
    assert.deepEqual([...resp!.parsed!.apduData.subarray(0, 2)], [0x07, 0xb0]);
    // Every recorded frame has a human-readable one-line decode.
    for (const f of conn.frames) assert.match(f.decoded, /->/);
  });

  it('answers PID_TABLE_REFERENCE reads from the configured table bases', async () => {
    const conn = new KnxLoopbackConnection(
      config({ tableBases: { 4: PARAM_BASE } }),
    );
    await conn.downloadDevice(ADDR, steps, null, null, payload, undefined, {
      mode: 'full',
    });
    // With no resolvedBases supplied, the orchestration must have asked the device
    // (property 7 of object 4) and used the loopback's answer as the write address.
    assert.ok(conn.memoryWrites.length >= 1);
    assert.equal(conn.memoryWrites[0]!.address, PARAM_BASE);
    assert.equal(conn.memoryWrites[0]!.objIdx, 4);
  });

  it('uses the configured PID_MCB_TABLE byte 5 to answer the memory-write-service question', async () => {
    const run = async (mcbByte5: number) => {
      const conn = new KnxLoopbackConnection(config({ mcbByte5 }));
      await conn.downloadDevice(ADDR, steps, null, null, payload, undefined, {
        resolvedBases: { 4: PARAM_BASE },
        mode: 'full',
      });
      return conn;
    };
    const extended = await run(0x33);
    assert.ok(extended.memoryWrites.length > 0);
    assert.ok(extended.memoryWrites.every((w) => w.extended));
    const legacy = await run(0xff);
    assert.ok(legacy.memoryWrites.length > 0);
    assert.ok(legacy.memoryWrites.every((w) => !w.extended));
    // Same bytes either way - only the service differs.
    const flat = (c: KnxLoopbackConnection) =>
      Buffer.concat(c.memoryWrites.map((w) => w.data)).toString('hex');
    assert.equal(flat(extended), flat(legacy));
  });

  it('leaves the object attribution empty for a write below every configured table base', async () => {
    const conn = new KnxLoopbackConnection(config());
    await conn.downloadDevice(ADDR, steps, null, null, payload, undefined, {
      resolvedBases: { 4: 0x2000 },
      mode: 'full',
    });
    assert.ok(conn.memoryWrites.length > 0);
    assert.ok(conn.memoryWrites.every((w) => w.objIdx === null));
    assert.equal(conn.memoryWrites[0]!.address, 0x2000);
  });

  it('answers the extended Restart with a Restart_Extended_Response', async () => {
    const conn = new KnxLoopbackConnection(config());
    await conn.downloadDevice(ADDR, steps, null, null, payload, undefined, {
      resolvedBases: { 4: PARAM_BASE },
      mode: 'full',
    });
    const sent = conn.frames.filter(
      (f) => f.direction === 'out' && f.parsed?.apciName === 'Restart_Extended',
    );
    assert.equal(
      sent.length,
      1,
      'a System B device is restarted with the extended service',
    );
    const answered = conn.frames.filter(
      (f) =>
        f.direction === 'in' &&
        f.parsed?.apciName === 'Restart_Extended_Response',
    );
    assert.equal(answered.length, 1);
    assert.deepEqual([...answered[0]!.parsed!.apduData], [0x00, 0x00, 0x00]);
  });
});
