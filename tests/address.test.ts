/**
 * shared/address.ts - the one place that knows what a KNX address is.
 *
 * The ranges are the wire format's: an individual address is 4/4/8 bits and
 * a group address 5/3/8. Anything outside that cannot be carried, which is
 * why parsing rejects it rather than masking it down - see encodeGroup() in
 * server/knx-cemi.ts for what masking used to do.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIA,
  parseGA,
  formatIA,
  formatGA,
  isValidIA,
  isValidGA,
  compareAddr,
} from '../shared/address.ts';
import { encodeGroup, encodePhysical } from '../server/knx-cemi.ts';

describe('parseIA', () => {
  it('parses a real address', () => {
    assert.deepEqual(parseIA('1.1.10'), { area: 1, line: 1, device: 10 });
    assert.deepEqual(parseIA('0.0.0'), { area: 0, line: 0, device: 0 });
    assert.deepEqual(parseIA('15.15.255'), {
      area: 15,
      line: 15,
      device: 255,
    });
  });

  it('rejects anything the wire cannot carry', () => {
    for (const a of ['16.0.0', '0.16.0', '0.0.256', '99.99.999']) {
      assert.equal(parseIA(a), null, a);
    }
  });

  it('rejects anything that is not the shape', () => {
    for (const a of ['1.1', '1.1.1.1', '1/1/1', ' 1.1.1', '1.1.1 ', '', null]) {
      assert.equal(parseIA(a), null, JSON.stringify(a));
    }
  });

  it('round-trips through formatIA', () => {
    assert.equal(formatIA(parseIA('3.4.200')!), '3.4.200');
  });
});

describe('parseGA', () => {
  it('parses a real address', () => {
    assert.deepEqual(parseGA('1/2/3'), { main: 1, middle: 2, sub: 3 });
    assert.deepEqual(parseGA('31/7/255'), { main: 31, middle: 7, sub: 255 });
  });

  it('rejects anything the wire cannot carry', () => {
    for (const a of ['32/0/0', '0/8/0', '0/0/256', '99/99/999']) {
      assert.equal(parseGA(a), null, a);
    }
  });

  // Two-level is a storage and display convention here, not something the
  // wire path has ever resolved - see encodeGroup()'s comment.
  it('does not accept a two-level address', () => {
    assert.equal(parseGA('1/2'), null);
  });

  it('round-trips through formatGA', () => {
    assert.equal(formatGA(parseGA('9/3/44')!), '9/3/44');
  });
});

describe('isValidIA / isValidGA', () => {
  it('agree with the parsers', () => {
    assert.equal(isValidIA('1.1.1'), true);
    assert.equal(isValidIA('99.1.1'), false);
    assert.equal(isValidGA('1/1/1'), true);
    assert.equal(isValidGA('99/1/1'), false);
  });
});

describe('compareAddr', () => {
  it('orders by number, not by string', () => {
    const sorted = ['1.1.10', '1.1.2', '1.10.1', '1.2.1'].sort(compareAddr);
    assert.deepEqual(sorted, ['1.1.2', '1.1.10', '1.2.1', '1.10.1']);
  });

  it('orders group addresses the same way', () => {
    const sorted = ['1/1/10', '1/1/2', '10/0/0', '2/0/0'].sort(compareAddr);
    assert.deepEqual(sorted, ['1/1/2', '1/1/10', '2/0/0', '10/0/0']);
  });

  it('does not reject what it cannot parse - sorting is no place to be strict', () => {
    const sorted = ['1.1.2', '-.-.-', '1.1.1'].sort(compareAddr);
    assert.deepEqual(sorted.slice(0, 2), ['1.1.1', '1.1.2']);
    assert.equal(sorted[2], '-.-.-');
  });
});

describe('the encoders refuse what they cannot carry', () => {
  it('encodes a valid address', () => {
    assert.equal(encodeGroup('1/2/3').toString('hex'), '0a03');
    assert.equal(encodeGroup('31/7/255').toString('hex'), 'ffff');
    assert.equal(encodePhysical('1.1.10').toString('hex'), '110a');
  });

  // It used to mask: 99/99/999 encoded as 1be7, which is 3/3/231 - a real
  // address, and the telegram went there.
  it('throws rather than writing to a different address', () => {
    assert.throws(() => encodeGroup('99/99/999'), /Invalid group address/);
    assert.throws(() => encodeGroup('1/2/256'), /Invalid group address/);
    assert.throws(() => encodePhysical('99.99.999'), /Invalid individual/);
    assert.throws(() => encodePhysical('nonsense'), /Invalid individual/);
  });

  // Preserved, not endorsed - see encodeGroup()'s own comment.
  it('still pads a two-level group address to three levels', () => {
    assert.equal(encodeGroup('1/2').toString('hex'), '0a00');
  });
});
