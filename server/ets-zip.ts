/**
 * ETS6 ZIP and encryption helpers.
 *
 * Handles:
 *   - Opening .knxproj ZIP archives via minizip-asm.js
 *   - Detecting AES-encrypted file buffers
 *   - Deriving the ZIP password for ETS6 password-protected projects
 *   - Decrypting ETS5/6 file-level AES-256-CBC encrypted buffers
 */

import { createRequire } from 'module';
import crypto from 'crypto';
import { logger } from './log.ts';

export interface MinizipEntry {
  filepath: string;
}
export interface MinizipInstance {
  list(): MinizipEntry[];
  extract(filepath: string, options?: { password?: string }): Uint8Array;
}

export interface ZipEntry {
  entryName: string;
  getData(): Buffer;
  /**
   * Drop the cached extracted Buffer.
   *
   * getData() memoises, which is right for the handful of entries read more
   * than once (0.xml, project.xml) and very wrong for the application
   * programs: a large project holds hundreds of them, they are read exactly
   * once each, and the entry list outlives the whole parse - so without this
   * every extracted program stays resident until the import finishes. Call
   * it as soon as a one-shot entry has been consumed.
   */
  release(): void;
}

const require_ = createRequire(import.meta.url);
const Minizip = require_('minizip-asm.js') as new (
  data: Buffer,
) => MinizipInstance;

/** Open a ZIP buffer and return entries compatible with the ZipEntry interface. */
export function openZip(buffer: Buffer, password?: string): ZipEntry[] {
  const mz = new Minizip(buffer);
  const opts = password ? { password } : undefined;
  const encrypted = !!password;
  return mz.list().map((f) => {
    let cached: Buffer | null = null;
    return {
      entryName: f.filepath,
      release: () => {
        cached = null;
      },
      getData: () => {
        if (cached) return cached;
        const t0 = Date.now();
        try {
          const out = Buffer.from(mz.extract(f.filepath, opts));
          cached = out;
          logger.info('ets', 'extract', {
            name: f.filepath,
            bytes: out.length,
            ms: Date.now() - t0,
            encrypted,
          });
          return out;
        } catch (e) {
          logger.warn('ets', 'extract failed', {
            name: f.filepath,
            ms: Date.now() - t0,
            encrypted,
            error: (e as Error).message,
          });
          throw e;
        }
      },
    };
  });
}

// ─── Encryption helpers ───────────────────────────────────────────────────────

/** Returns true if the buffer is not plaintext XML (i.e. likely AES-encrypted). */
export function looksEncrypted(buf: Buffer | null | undefined): boolean {
  if (!buf || buf.length < 2) return false;
  // Skip leading whitespace and BOM
  let i = 0;
  // UTF-8 BOM (EF BB BF)
  if (buf[0] === 0xef && buf[1] === 0xbb) i = 3;
  // Skip whitespace (space, tab, newline, carriage return)
  while (
    i < buf.length &&
    (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)
  )
    i++;
  // Plain XML starts with '<'
  if (i < buf.length && buf[i] === 0x3c) return false;
  return true;
}

/**
 * Derive the ZIP password for an ETS6 password-protected inner archive.
 * ETS6 uses PBKDF2-HMAC-SHA256 with a fixed salt, then base64-encodes the result.
 */
export function deriveZipPassword(password: string): string {
  const t0 = Date.now();
  const derived = crypto.pbkdf2Sync(
    Buffer.from(password, 'utf16le'),
    '21.project.ets.knx.org',
    65536,
    32,
    'sha256',
  );
  logger.info('ets', 'pbkdf2 (zip) done', { ms: Date.now() - t0 });
  return derived.toString('base64');
}

/**
 * Decrypt an ETS5/6 file-level AES-256-CBC encrypted buffer.
 */
export function decryptEntry(buf: Buffer, password: string): Buffer {
  if (buf.length < 40)
    throw Object.assign(new Error('Encrypted file too short'), {
      code: 'PASSWORD_INCORRECT',
    });
  const salt = buf.slice(0, 20);
  const iterations = buf.readUInt32BE(20);
  const iv = buf.slice(24, 40);
  const data = buf.slice(40);
  const tPbkdf2 = Date.now();
  const key = crypto.pbkdf2Sync(
    Buffer.from(password, 'utf16le'),
    salt,
    iterations,
    32,
    'sha256',
  );
  logger.info('ets', 'pbkdf2 (file) done', {
    iterations,
    bytes: data.length,
    ms: Date.now() - tPbkdf2,
  });
  try {
    const tAes = Date.now();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const out = Buffer.concat([decipher.update(data), decipher.final()]);
    logger.info('ets', 'aes-cbc decrypt done', {
      bytes: data.length,
      ms: Date.now() - tAes,
    });
    return out;
  } catch (e) {
    logger.warn('ets', 'aes-cbc decrypt failed', {
      error: (e as Error).message,
    });
    throw Object.assign(new Error('Incorrect password'), {
      code: 'PASSWORD_INCORRECT',
    });
  }
}
