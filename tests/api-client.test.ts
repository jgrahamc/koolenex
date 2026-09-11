/**
 * client/src/api.ts's req() - what every call to the server goes through,
 * and what every error the UI shows comes out of.
 *
 * Nothing tested this. Its error mapping is not obvious: the server has two
 * conventions for reporting a failure, and which field becomes the message
 * and which becomes the code decides both what a person reads in the log
 * and what errCode() sees when a caller branches on it - ProgrammingView's
 * Cancel and address-confirmation flows both do.
 *
 * Driven through the public api.* methods with fetch stubbed, so req()
 * needs no export of its own and the real call path is what runs.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, errCode, errMessage } from '../client/src/api.ts';

const realFetch = globalThis.fetch;

/** The last request req() made, for asserting what went on the wire. */
let lastCall: { url: string; opts: RequestInit } | null = null;

/** Answer the next fetch with this status and body. */
function respond(status: number, body: unknown, statusText = '') {
  globalThis.fetch = ((url: string, opts: RequestInit) => {
    lastCall = { url, opts };
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText,
      json: () => Promise.resolve(body),
    } as Response);
  }) as typeof fetch;
}

/** Fail the next fetch the way the browser does. */
function reject(err: unknown) {
  globalThis.fetch = (() => Promise.reject(err)) as typeof fetch;
}

beforeEach(() => {
  lastCall = null;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('req: a successful call', () => {
  it('returns the parsed body', async () => {
    respond(200, [{ id: 1, name: 'P' }]);
    assert.deepEqual(await api.listProjects(), [{ id: 1, name: 'P' }]);
  });

  it('prefixes the path with /api', async () => {
    respond(200, {});
    await api.getProject(7);
    assert.equal(lastCall!.url, '/api/projects/7');
  });

  it('sends a JSON body with a JSON content type', async () => {
    respond(200, {});
    await api.createProject('New');
    const h = lastCall!.opts.headers as Record<string, string>;
    assert.equal(h['Content-Type'], 'application/json');
    assert.equal(lastCall!.opts.body, JSON.stringify({ name: 'New' }));
  });

  it('sends FormData as-is, with no content type of our own', async () => {
    // Setting Content-Type by hand would strip the multipart boundary the
    // browser generates, and multer would reject the upload.
    respond(200, {});
    const fd = new FormData();
    fd.append('file', new Blob(['x']), 'p.knxprod');
    await api.importKnxprod(1, fd);
    const h = lastCall!.opts.headers as Record<string, string>;
    assert.equal(h['Content-Type'], undefined);
    assert.equal(lastCall!.opts.body, fd);
  });
});

describe('req: the two server error conventions', () => {
  // Most bus routes: a short identifying string in `error`, the prose in
  // `message`. The person should read the prose; a caller branching on the
  // failure should get the identifier.
  it('takes the message as the text and the error as the code', async () => {
    respond(400, {
      error: 'no_ldctrl',
      message: 'No load procedures found. Re-import the project.',
    });
    const e = await api.busProgramDevice('1.1.1', 1, 1).catch((x) => x);
    assert.ok(e instanceof ApiError);
    assert.equal(
      errMessage(e),
      'No load procedures found. Re-import the project.',
    );
    assert.equal(errCode(e), 'no_ldctrl');
  });

  // Project import: friendly text directly in `error`, with its own `code`.
  it('takes an explicit code over the derived one', async () => {
    respond(409, {
      error: 'An import is already in progress',
      code: 'IMPORT_BUSY',
      activeImportId: 'abc',
    });
    const e = await api.createProject('x').catch((x) => x);
    assert.equal(errMessage(e), 'An import is already in progress');
    assert.equal(errCode(e), 'IMPORT_BUSY');
  });

  it('leaves the code unset when only an error string came back', async () => {
    respond(404, { error: 'Not found' });
    const e = await api.getProject(9).catch((x) => x);
    assert.equal(errMessage(e), 'Not found');
    assert.equal(errCode(e), undefined);
  });

  it('falls back to the status text when the body says nothing', async () => {
    respond(500, {}, 'Internal Server Error');
    const e = await api.getProject(9).catch((x) => x);
    assert.equal(errMessage(e), 'Internal Server Error');
  });

  // /bus/program-device attaches canUseSerial to the 409 that asks the
  // operator how to locate a device; AddressDeviceModal reads it off .data.
  it('keeps the whole body for callers that need the extra fields', async () => {
    respond(409, {
      error: 'address_needs_confirmation',
      message: 'Device not found - choose how to address it.',
      canUseSerial: true,
    });
    const e = (await api
      .busProgramDevice('1.1.1', 1, 1)
      .catch((x) => x)) as ApiError;
    assert.equal(e.data?.canUseSerial, true);
    assert.equal(errCode(e), 'address_needs_confirmation');
  });
});

describe('req: the request never reached the server', () => {
  // The whole Cancel flow keys on this code: ProgrammingView treats
  // 'aborted' as "not a failure" and reverts the button rather than
  // showing an error.
  it('turns an aborted request into code "aborted"', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    reject(abort);
    const e = await api.getProject(1).catch((x) => x);
    assert.ok(e instanceof ApiError);
    assert.equal(errMessage(e), 'Cancelled');
    assert.equal(errCode(e), 'aborted');
  });

  it('reports a network failure as one, with the cause in the text', async () => {
    reject(new TypeError('Failed to fetch'));
    const e = await api.getProject(1).catch((x) => x);
    assert.ok(e instanceof ApiError);
    assert.match(errMessage(e), /Network error or request timed out/);
    assert.match(errMessage(e), /Failed to fetch/);
    assert.equal(errCode(e), undefined);
  });
});

describe('errMessage / errCode', () => {
  it('handle anything, not just ApiError', () => {
    assert.equal(errMessage(new Error('plain')), 'plain');
    assert.equal(errMessage('a string'), 'a string');
    assert.equal(errCode(new Error('plain')), undefined);
    assert.equal(errCode('a string'), undefined);
  });
});
