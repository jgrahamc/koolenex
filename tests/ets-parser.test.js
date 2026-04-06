const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const { clean, interp } = require('../server/ets-parser');

describe('clean()', () => {
  test('returns empty string for null/undefined', () => {
    assert.equal(clean(null), '');
    assert.equal(clean(undefined), '');
    assert.equal(clean(''), '');
  });

  test('decodes hex numeric character references', () => {
    assert.equal(clean('&#x2019;'), '\u2019');
    assert.equal(clean('&#x26;'), '&');
    assert.equal(clean('a&#x20;b'), 'a b', 'space entity between chars');
  });

  test('decodes decimal numeric character references', () => {
    assert.equal(clean('&#8217;'), '\u2019');
    assert.equal(clean('a&#32;b'), 'a b', 'space entity between chars');
  });

  test('strips ASCII control characters (0x00-0x1F, 0x7F)', () => {
    assert.equal(clean('hello\x00world'), 'hello world');
    assert.equal(clean('hello\x1Fworld'), 'hello world');
    assert.equal(clean('hello\x7Fworld'), 'hello world');
    assert.equal(clean('a\x01b\x02c\x03d'), 'a b c d');
  });

  test('collapses multiple spaces into one', () => {
    assert.equal(clean('hello   world'), 'hello world');
    assert.equal(clean('  hello  world  '), 'hello world');
  });

  test('trims leading and trailing whitespace', () => {
    assert.equal(clean('  hello  '), 'hello');
    assert.equal(clean('\t\nhello\n\t'), 'hello');
  });

  test('handles mixed entity decoding and control char stripping', () => {
    const input = 'Hello\u2019s\x00World';
    assert.equal(clean(input), 'Hello\u2019s World');
  });

  test('converts non-string values to string', () => {
    assert.equal(clean(42), '42');
    assert.equal(clean(true), 'true');
  });
});

describe('interp()', () => {
  test('returns empty string for null/undefined template', () => {
    assert.equal(interp(null, {}), '');
    assert.equal(interp(undefined, {}), '');
    assert.equal(interp('', {}), '');
  });

  test('resolves named args from map', () => {
    assert.equal(interp('{{argCH}}', { argCH: 'Channel 1' }), 'Channel 1');
  });

  test('uses empty string for missing named args', () => {
    assert.equal(interp('{{missing}}', {}), '');
  });

  test('resolves numbered args with default text', () => {
    assert.equal(interp('{{0: Channel A}}', { 0: 'Blind' }), 'Blind');
    assert.equal(interp('{{0: Channel A}}', {}), 'Channel A');
  });

  test('handles whitespace around colon in numbered args', () => {
    assert.equal(interp('{{0:Default}}', { 0: 'X' }), 'X');
    assert.equal(interp('{{0 : Default}}', { 0: 'X' }), 'X');
  });

  test('strips trailing colons, dashes, and whitespace', () => {
    assert.equal(interp('Switch {{argCH}}:', { argCH: 'A' }), 'Switch A');
    assert.equal(interp('Switch {{argCH}} -', { argCH: 'A' }), 'Switch A');
    assert.equal(interp('Switch {{argCH}} –', { argCH: 'A' }), 'Switch A');
    assert.equal(interp('Switch {{argCH}} —', { argCH: 'A' }), 'Switch A');
    assert.equal(interp('Switch {{argCH}}:  ', { argCH: 'A' }), 'Switch A');
  });

  test('handles multiple placeholders in one string', () => {
    assert.equal(
      interp('{{0: Move}} {{argCH}} Up/Down', { 0: 'Raise', argCH: 'Blind' }),
      'Raise Blind Up/Down',
    );
  });

  test('applies clean() to result (control chars, whitespace)', () => {
    assert.equal(interp('Hello\x00World', {}), 'Hello World');
    assert.equal(interp('  hello  world  ', {}), 'hello world');
  });

  test('handles realistic ETS function text templates', () => {
    const map = { argCH: 'Output 1', 0: 'Brightness' };
    assert.equal(
      interp('Set {{0: Value}} on {{argCH}}', map),
      'Set Brightness on Output 1',
    );
    assert.equal(interp('Value {{argCH}}:', map), 'Value Output 1');
  });

  test('returns default text when numbered arg not in map', () => {
    assert.equal(interp('{{0: Channel A}}', {}), 'Channel A');
    assert.equal(interp('Move {{0: Shutter}}', {}), 'Move Shutter');
  });

  test('passes through string with no placeholders', () => {
    assert.equal(interp('Plain text', {}), 'Plain text');
    assert.equal(
      interp('No placeholders here', { argCH: 'X' }),
      'No placeholders here',
    );
  });

  test('passes through malformed unclosed {{', () => {
    assert.equal(interp('Hello {{world', {}), 'Hello {{world');
    assert.equal(interp('Test {{', {}), 'Test {{');
  });

  test('handles empty default {{0: }}', () => {
    assert.equal(interp('{{0: }}', {}), '');
    assert.equal(
      interp('Label: {{0: }}', {}),
      'Label',
      'trailing colon is stripped after empty default resolves',
    );
  });
});
