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
}

const require_ = createRequire(import.meta.url);
const Minizip = require_('minizip-asm.js') as new (
  data: Buffer,
) => MinizipInstance;

/** Open a ZIP buffer and return entries compatible with the ZipEntry interface. */
export function openZip(buffer: Buffer, password?: string): ZipEntry[] {
  const mz = new Minizip(buffer);
  const opts = password ? { password } : undefined;
  return mz.list().map((f) => {
    const data = Buffer.from(mz.extract(f.filepath, opts));
    return { entryName: f.filepath, getData: () => data };
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
  const derived = crypto.pbkdf2Sync(
    Buffer.from(password, 'utf16le'),
    '21.project.ets.knx.org',
    65536,
    32,
    'sha256',
  );
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
  const key = crypto.pbkdf2Sync(
    Buffer.from(password, 'utf16le'),
    salt,
    iterations,
    32,
    'sha256',
  );
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (_) {
    throw Object.assign(new Error('Incorrect password'), {
      code: 'PASSWORD_INCORRECT',
    });
  }
}
