/**
 * minizip-asm.js overwrites the process-global ArrayBuffer and DataView with
 * polyfilled versions when it is imported. server/minizip.ts restores the
 * native ones straight after, so importing the ETS zip helpers must leave
 * both globals exactly as they were.
 *
 * The native constructors are captured before the import (a dynamic import, so
 * it happens after this line runs); comparing against anything derived
 * afterwards would compare the polyfill with itself.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const NativeArrayBuffer = globalThis.ArrayBuffer;
const NativeDataView = globalThis.DataView;

await import('../server/ets-zip.ts');

describe('importing the ETS zip helpers', () => {
  it('leaves the global ArrayBuffer and DataView native', () => {
    assert.equal(globalThis.ArrayBuffer, NativeArrayBuffer);
    assert.equal(globalThis.DataView, NativeDataView);
  });
});
