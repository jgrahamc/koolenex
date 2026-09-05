import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeText,
  interpolate,
  deriveDeviceStatus,
} from '../server/ets-parser.ts';

// Real evidence for this, 2026-08-29: the live Test Bed.knxproj has a real
// DeviceInstance where LastModified is AFTER LastDownload (edited in ETS
// since its last download) - the previous logic (LastDownload present ?
// 'programmed' : 'unassigned') ignored LastModified entirely and would have
// misclassified this real device as 'programmed'. See
// docs/knx-device-write-protocol.md-adjacent session notes / the
// deriveDeviceStatus() doc comment for the full real-timestamp example.
describe('deriveDeviceStatus()', () => {
  test('no LastDownload at all -> unassigned, regardless of LastModified', () => {
    assert.equal(deriveDeviceStatus('2026-08-29T13:32:51.9340101Z', ''), 'unassigned');
    assert.equal(deriveDeviceStatus('', ''), 'unassigned');
  });

  test('LastDownload after LastModified -> programmed', () => {
    assert.equal(
      deriveDeviceStatus(
        '2026-08-26T15:41:42.5035215Z',
        '2026-08-26T15:41:58.7770377Z',
      ),
      'programmed',
    );
  });

  test('LastModified after LastDownload -> modified (real Test Bed example)', () => {
    assert.equal(
      deriveDeviceStatus(
        '2026-08-29T20:44:00.5875066Z',
        '2026-08-29T17:05:02.3787468Z',
      ),
      'modified',
    );
  });

  test('LastDownload present, no LastModified -> programmed', () => {
    assert.equal(
      deriveDeviceStatus('', '2026-08-26T15:41:58.7770377Z'),
      'programmed',
    );
  });

  test('unparsable timestamps fall back to programmed, not a throw', () => {
    assert.equal(deriveDeviceStatus('not-a-date', '2026-08-26T15:41:58Z'), 'programmed');
    assert.equal(deriveDeviceStatus('2026-08-26T15:41:58Z', 'not-a-date'), 'programmed');
  });

  test('equal timestamps -> programmed (not modified)', () => {
    const t = '2026-08-26T15:41:58.7770377Z';
    assert.equal(deriveDeviceStatus(t, t), 'programmed');
  });
});

describe('sanitizeText()', () => {
  test('returns empty string for null/undefined', () => {
    assert.equal(sanitizeText(null), '');
    assert.equal(sanitizeText(undefined), '');
    assert.equal(sanitizeText(''), '');
  });

  test('decodes hex numeric character references', () => {
    assert.equal(sanitizeText('&#x2019;'), '\u2019');
    assert.equal(sanitizeText('&#x26;'), '&');
    assert.equal(sanitizeText('a&#x20;b'), 'a b', 'space entity between chars');
  });

  test('decodes decimal numeric character references', () => {
    assert.equal(sanitizeText('&#8217;'), '\u2019');
    assert.equal(sanitizeText('a&#32;b'), 'a b', 'space entity between chars');
  });

  test('strips ASCII control characters (0x00-0x1F, 0x7F)', () => {
    assert.equal(sanitizeText('hello\x00world'), 'hello world');
    assert.equal(sanitizeText('hello\x1Fworld'), 'hello world');
    assert.equal(sanitizeText('hello\x7Fworld'), 'hello world');
    assert.equal(sanitizeText('a\x01b\x02c\x03d'), 'a b c d');
  });

  test('collapses multiple spaces into one', () => {
    assert.equal(sanitizeText('hello   world'), 'hello world');
    assert.equal(sanitizeText('  hello  world  '), 'hello world');
  });

  test('trims leading and trailing whitespace', () => {
    assert.equal(sanitizeText('  hello  '), 'hello');
    assert.equal(sanitizeText('\t\nhello\n\t'), 'hello');
  });

  test('handles mixed entity decoding and control char stripping', () => {
    const input = 'Hello\u2019s\x00World';
    assert.equal(sanitizeText(input), 'Hello\u2019s World');
  });

  test('converts non-string values to string', () => {
    assert.equal(sanitizeText(42), '42');
    assert.equal(sanitizeText(true), 'true');
  });
});

describe('interpolate()', () => {
  test('returns empty string for null/undefined template', () => {
    assert.equal(interpolate(null, {}), '');
    assert.equal(interpolate(undefined, {}), '');
    assert.equal(interpolate('', {}), '');
  });

  test('resolves named args from map', () => {
    assert.equal(interpolate('{{argCH}}', { argCH: 'Channel 1' }), 'Channel 1');
  });

  test('uses empty string for missing named args', () => {
    assert.equal(interpolate('{{missing}}', {}), '');
  });

  test('resolves numbered args with default text', () => {
    assert.equal(interpolate('{{0: Channel A}}', { 0: 'Blind' }), 'Blind');
    assert.equal(interpolate('{{0: Channel A}}', {}), 'Channel A');
  });

  test('handles whitespace around colon in numbered args', () => {
    assert.equal(interpolate('{{0:Default}}', { 0: 'X' }), 'X');
    assert.equal(interpolate('{{0 : Default}}', { 0: 'X' }), 'X');
  });

  test('strips trailing colons, dashes, and whitespace', () => {
    assert.equal(interpolate('Switch {{argCH}}:', { argCH: 'A' }), 'Switch A');
    assert.equal(interpolate('Switch {{argCH}} -', { argCH: 'A' }), 'Switch A');
    assert.equal(interpolate('Switch {{argCH}} –', { argCH: 'A' }), 'Switch A');
    assert.equal(interpolate('Switch {{argCH}} —', { argCH: 'A' }), 'Switch A');
    assert.equal(
      interpolate('Switch {{argCH}}:  ', { argCH: 'A' }),
      'Switch A',
    );
  });

  test('handles multiple placeholders in one string', () => {
    assert.equal(
      interpolate('{{0: Move}} {{argCH}} Up/Down', {
        0: 'Raise',
        argCH: 'Blind',
      }),
      'Raise Blind Up/Down',
    );
  });

  test('applies sanitizeText() to result (control chars, whitespace)', () => {
    assert.equal(interpolate('Hello\x00World', {}), 'Hello World');
    assert.equal(interpolate('  hello  world  ', {}), 'hello world');
  });

  test('handles realistic ETS function text templates', () => {
    const map = { argCH: 'Output 1', 0: 'Brightness' };
    assert.equal(
      interpolate('Set {{0: Value}} on {{argCH}}', map),
      'Set Brightness on Output 1',
    );
    assert.equal(interpolate('Value {{argCH}}:', map), 'Value Output 1');
  });

  test('returns default text when numbered arg not in map', () => {
    assert.equal(interpolate('{{0: Channel A}}', {}), 'Channel A');
    assert.equal(interpolate('Move {{0: Shutter}}', {}), 'Move Shutter');
  });

  test('passes through string with no placeholders', () => {
    assert.equal(interpolate('Plain text', {}), 'Plain text');
    assert.equal(
      interpolate('No placeholders here', { argCH: 'X' }),
      'No placeholders here',
    );
  });

  test('passes through malformed unclosed {{', () => {
    assert.equal(interpolate('Hello {{world', {}), 'Hello {{world');
    assert.equal(interpolate('Test {{', {}), 'Test {{');
  });

  test('handles empty default {{0: }}', () => {
    assert.equal(interpolate('{{0: }}', {}), '');
    assert.equal(
      interpolate('Label: {{0: }}', {}),
      'Label',
      'trailing colon is stripped after empty default resolves',
    );
  });
});
