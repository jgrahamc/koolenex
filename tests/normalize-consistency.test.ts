/**
 * The DPT key normaliser, and the two adapters over it.
 *
 * This file used to exist to keep two hand-maintained copies in step - one
 * in client/src/dpt.ts, one in server/routes/bus.ts. There is one
 * implementation now (shared/dpt-key.ts) and the copies are gone, so the
 * agreement below is structural rather than a coincidence to guard.
 *
 * What still needs pinning is where the two callers deliberately differ:
 * the server wants null for "no usable key" so the decoder knows to skip,
 * and the client wants the input back so dptInfo() can resolve a bare main
 * number to its family's .001 entry.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDpt } from '../client/src/dpt.ts';
import { normalizeDptKey } from '../server/routes/index.ts';

describe('normalizeDpt (client) and normalizeDptKey (server)', () => {
  // Inputs where both should produce the same non-null result
  const agreeCases: [string, string][] = [
    ['DPST-9-1', '9.001'],
    ['DPT-9-1', '9.001'],
    ['DPST-14-68', '14.068'],
    ['DPST-1-1', '1.001'],
    ['dpst-5-1', '5.001'],
    ['DPT-232-600', '232.600'],
    ['9.001', '9.001'],
    ['9.1', '9.001'],
    ['14.68', '14.068'],
    ['1.1', '1.001'],
    ['232.600', '232.600'],
    ['5.001', '5.001'],
  ];

  for (const [input, expected] of agreeCases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      assert.equal(normalizeDpt(input), expected, 'client');
      assert.equal(normalizeDptKey(input), expected, 'server');
    });
  }

  // Both return empty/null for these
  it('both return empty/null for null', () => {
    assert.equal(normalizeDpt(null), '');
    assert.equal(normalizeDptKey(null), null);
  });

  it('both return empty/null for empty string', () => {
    assert.equal(normalizeDpt(''), '');
    assert.equal(normalizeDptKey(''), null);
  });

  // Known divergence: bare number — client passes through, server returns null
  it('bare number "9": client returns "9", server returns null', () => {
    assert.equal(normalizeDpt('9'), '9');
    assert.equal(normalizeDptKey('9'), null);
  });
});

describe('normalizeDptKey (shared)', () => {
  it('trims, so a stray space cannot survive into the key', () => {
    // The server's own copy did not trim: ' 9.1' padded to ' 9.001', which
    // matched nothing in the DPT tables.
    assert.equal(normalizeDptKey(' 9.1 '), '9.001');
    assert.equal(normalizeDptKey('  DPST-9-1  '), '9.001');
  });

  it('takes a number as well as a string', () => {
    // dptInfo() is called with both across the client.
    assert.equal(normalizeDptKey(9), null);
    assert.equal(normalizeDptKey('9'), null);
  });

  it('is null for anything with no key in it', () => {
    assert.equal(normalizeDptKey('  '), null);
    assert.equal(normalizeDptKey('nonsense'), null);
    assert.equal(normalizeDptKey(undefined), null);
  });

  it('pads a missing or short subtype', () => {
    assert.equal(normalizeDptKey('9.'), '9.000');
    assert.equal(normalizeDptKey('14.68'), '14.068');
  });
});
