/**
 * server/ets-zip.ts - opening a .knxproj, and the two crypto steps a
 * password-protected one needs.
 *
 * Nothing tested this directly. The password-protected smoke fixture
 * exercises it end to end, so a regression here shows up as "that whole
 * project stopped opening" rather than as a failure pointing at the
 * constant that changed. Every value below is fixed by ETS's own format:
 * the salt string, the iteration count, UTF-16LE for the password, and
 * where the salt, iteration count and IV sit in an encrypted entry.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import {
  openZip,
  looksEncrypted,
  deriveZipPassword,
  decryptEntry,
} from '../server/ets-zip.ts';
import { SMOKE_PROJECT } from './helpers.ts';

describe('looksEncrypted', () => {
  it('says no to plain XML', () => {
    assert.equal(looksEncrypted(Buffer.from('<KNX/>')), false);
  });

  it('sees past a UTF-8 BOM', () => {
    const bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<KNX/>'),
    ]);
    assert.equal(looksEncrypted(bom), false);
  });

  it('sees past leading whitespace', () => {
    assert.equal(looksEncrypted(Buffer.from('\r\n\t  <KNX/>')), false);
  });

  it('says yes to bytes that are not XML', () => {
    assert.equal(looksEncrypted(Buffer.from([0x00, 0x01, 0x02, 0x03])), true);
  });

  it('says no to nothing at all', () => {
    // Not "encrypted" - there is simply nothing here to decrypt.
    assert.equal(looksEncrypted(null), false);
    assert.equal(looksEncrypted(Buffer.alloc(0)), false);
    assert.equal(looksEncrypted(Buffer.from([0x3c])), false);
  });
});

describe('deriveZipPassword', () => {
  // ETS6: PBKDF2-HMAC-SHA256 over the UTF-16LE password with a fixed salt,
  // 65536 iterations, 32 bytes out, base64-encoded. Recomputed here
  // independently rather than pasted from the implementation, so changing
  // any one of those constants fails this.
  const expected = (pw: string) =>
    crypto
      .pbkdf2Sync(
        Buffer.from(pw, 'utf16le'),
        '21.project.ets.knx.org',
        65536,
        32,
        'sha256',
      )
      .toString('base64');

  it('derives the ETS6 zip password', () => {
    assert.equal(deriveZipPassword('secret'), expected('secret'));
  });

  it('treats the password as UTF-16LE, not UTF-8', () => {
    // A non-ASCII password is where the encoding choice actually shows.
    assert.equal(deriveZipPassword('pässwörd'), expected('pässwörd'));
    assert.notEqual(
      deriveZipPassword('pässwörd'),
      crypto
        .pbkdf2Sync(
          Buffer.from('pässwörd', 'utf8'),
          '21.project.ets.knx.org',
          65536,
          32,
          'sha256',
        )
        .toString('base64'),
    );
  });

  it('is stable and password-dependent', () => {
    assert.equal(deriveZipPassword('a'), deriveZipPassword('a'));
    assert.notEqual(deriveZipPassword('a'), deriveZipPassword('b'));
  });
});

describe('decryptEntry', () => {
  /** Build an entry the way ETS lays one out: salt(20) iter(4) iv(16) data. */
  function encrypt(plain: string, password: string, iterations = 1000) {
    const salt = crypto.randomBytes(20);
    const iv = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(
      Buffer.from(password, 'utf16le'),
      salt,
      iterations,
      32,
      'sha256',
    );
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const body = Buffer.concat([
      cipher.update(Buffer.from(plain, 'utf8')),
      cipher.final(),
    ]);
    const iterBuf = Buffer.alloc(4);
    iterBuf.writeUInt32BE(iterations);
    return Buffer.concat([salt, iterBuf, iv, body]);
  }

  it('round-trips a file', () => {
    const plain = '<KNX><Project/></KNX>';
    const out = decryptEntry(encrypt(plain, 'hunter2'), 'hunter2');
    assert.equal(out.toString('utf8'), plain);
  });

  it('reads the iteration count out of the entry, not a constant', () => {
    // Each file carries its own; hardcoding one would decrypt nothing.
    const plain = '<KNX/>';
    assert.equal(
      decryptEntry(encrypt(plain, 'pw', 2048), 'pw').toString('utf8'),
      plain,
    );
  });

  it('rejects the wrong password as PASSWORD_INCORRECT', () => {
    // The padding check fails, and the code is what the import flow turns
    // into a password prompt rather than a generic failure.
    const enc = encrypt('<KNX/>', 'right');
    const err = (() => {
      try {
        decryptEntry(enc, 'wrong');
        return null;
      } catch (e) {
        return e as Error & { code?: string };
      }
    })();
    assert.ok(err, 'expected a throw');
    assert.equal(err.code, 'PASSWORD_INCORRECT');
  });

  it('rejects a buffer too short to hold a header', () => {
    const err = (() => {
      try {
        decryptEntry(Buffer.alloc(39), 'pw');
        return null;
      } catch (e) {
        return e as Error & { code?: string };
      }
    })();
    assert.ok(err);
    assert.equal(err.code, 'PASSWORD_INCORRECT');
  });
});

describe('openZip', () => {
  it('lists the entries of a real .knxproj and reads one back', () => {
    const entries = openZip(fs.readFileSync(SMOKE_PROJECT));
    assert.ok(entries.length > 0);
    const master = entries.find((e) => e.entryName.endsWith('knx_master.xml'));
    assert.ok(master, 'expected a knx_master.xml');
    const data = master.getData();
    assert.ok(data.length > 0);
    // Real ETS master data starts with a UTF-8 BOM, which is exactly the
    // case looksEncrypted has to see past.
    assert.deepEqual([...data.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(looksEncrypted(data), false);
  });

  it('caches an entry until it is released', () => {
    const entries = openZip(fs.readFileSync(SMOKE_PROJECT));
    const e = entries.find((x) => x.entryName.endsWith('knx_master.xml'))!;
    const first = e.getData();
    assert.equal(e.getData(), first, 'second read should be the cached Buffer');
    e.release();
    const afterRelease = e.getData();
    assert.notEqual(afterRelease, first, 'release should drop the cache');
    assert.deepEqual(afterRelease, first, 'but the bytes are the same');
  });
});
