/**
 * Tests that client-side normalizeDpt and server-side normalizeDptKey
 * produce consistent results for all common input formats.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDpt } from '../client/src/dpt.ts';
import { normalizeDptKey } from '../server/routes/index.ts';

describe('normalizeDpt (client) vs normalizeDptKey (server) consistency', () => {
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
