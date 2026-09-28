// The one place minizip-asm.js is require()'d.
//
// minizip-asm.js bundles an old core-js polyfill that overwrites the global
// ArrayBuffer/DataView constructors as an import-time side effect, silently
// routing anything else in the process through the polyfill. Capture the
// native constructors before requiring the library and restore them right
// after, so nothing else ever observes the polyfilled ones.
//
// Only the raw constructor is exported; callers cast it to the narrow
// interface describing the methods they use.
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);

const NativeArrayBuffer = globalThis.ArrayBuffer;
const NativeDataView = globalThis.DataView;
export const rawMinizipCtor: unknown = require_('minizip-asm.js');
globalThis.ArrayBuffer = NativeArrayBuffer;
globalThis.DataView = NativeDataView;
