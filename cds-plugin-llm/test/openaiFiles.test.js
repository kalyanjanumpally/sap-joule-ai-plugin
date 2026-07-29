const { test } = require('node:test');
const assert = require('node:assert/strict');
const { uploadPdfFromUrl } = require('../lib/openaiFiles');

// Mock global fetch. Each test swaps in a fake that returns whatever is needed.
function withFetch(mock, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return fn().finally(() => { globalThis.fetch = original; });
}

test('uploadPdfFromUrl: rejects missing url', async () => {
  await assert.rejects(() => uploadPdfFromUrl(undefined, { apiKey: 'sk-x' }), /url is required/);
  await assert.rejects(() => uploadPdfFromUrl('', { apiKey: 'sk-x' }), /url is required/);
});

test('uploadPdfFromUrl: rejects missing apiKey', async () => {
  await assert.rejects(() => uploadPdfFromUrl('https://x/y.pdf', {}), /apiKey is required/);
});

test('uploadPdfFromUrl: surfaces download failure', async () => {
  const mock = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
  await withFetch(mock, async () => {
    await assert.rejects(
      () => uploadPdfFromUrl('https://x/missing.pdf', { apiKey: 'sk-x' }),
      /failed to fetch.*404/,
    );
  });
});

test('uploadPdfFromUrl: surfaces upload failure with body', async () => {
  const mock = async (url) => {
    if (url.endsWith('/missing.pdf')) {
      return {
        ok: true, status: 200,
        arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer, // %PDF
      };
    }
    return {
      ok: false, status: 401, statusText: 'Unauthorized',
      text: async () => 'invalid api key',
    };
  };
  await withFetch(mock, async () => {
    await assert.rejects(
      () => uploadPdfFromUrl('https://x/missing.pdf', { apiKey: 'wrong' }),
      /Files API upload failed.*401.*invalid api key/,
    );
  });
});

test('uploadPdfFromUrl: happy path — returns document block with file_id source', async () => {
  const requests = [];
  const mock = async (url, opts) => {
    requests.push({ url, opts });
    if (url === 'https://example.com/spec.pdf') {
      return {
        ok: true, status: 200,
        arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer,
      };
    }
    // Upload endpoint
    return {
      ok: true, status: 200,
      json: async () => ({ id: 'file-abc123', object: 'file', purpose: 'user_data' }),
    };
  };
  await withFetch(mock, async () => {
    const block = await uploadPdfFromUrl('https://example.com/spec.pdf', { apiKey: 'sk-test' });
    assert.deepEqual(block, {
      type: 'document',
      source: { type: 'file_id', file_id: 'file-abc123', mediaType: 'application/pdf' },
    });
    assert.equal(requests.length, 2);
    // Verify upload request shape
    const uploadReq = requests[1];
    assert.equal(uploadReq.url, 'https://api.openai.com/v1/files');
    assert.equal(uploadReq.opts.method, 'POST');
    assert.equal(uploadReq.opts.headers.Authorization, 'Bearer sk-test');
    assert.ok(uploadReq.opts.body instanceof FormData);
  });
});

test('uploadPdfFromUrl: custom baseUrl strips trailing slash', async () => {
  let uploadUrl = null;
  const mock = async (url) => {
    if (url === 'https://example.com/a.pdf') {
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    }
    uploadUrl = url;
    return { ok: true, json: async () => ({ id: 'file-x' }) };
  };
  await withFetch(mock, async () => {
    await uploadPdfFromUrl('https://example.com/a.pdf', {
      apiKey: 'sk-x',
      baseUrl: 'https://custom.openai.example.com/v1/',
    });
    assert.equal(uploadUrl, 'https://custom.openai.example.com/v1/files');
  });
});

test('uploadPdfFromUrl: infers filename from URL path', async () => {
  let uploadedFilename = null;
  const mock = async (url, opts) => {
    if (url.includes('/files')) {
      if (opts?.body instanceof FormData) uploadedFilename = opts.body.get('file')?.name;
      return { ok: true, json: async () => ({ id: 'file-x' }) };
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await withFetch(mock, async () => {
    await uploadPdfFromUrl('https://foo.example.com/contracts/2024-Q3.pdf', { apiKey: 'sk-x' });
    assert.equal(uploadedFilename, '2024-Q3.pdf');
  });
});

test('uploadPdfFromUrl: appends .pdf if URL basename lacks extension', async () => {
  let uploadedFilename = null;
  const mock = async (url, opts) => {
    if (url.includes('/files')) {
      if (opts?.body instanceof FormData) uploadedFilename = opts.body.get('file')?.name;
      return { ok: true, json: async () => ({ id: 'file-x' }) };
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await withFetch(mock, async () => {
    await uploadPdfFromUrl('https://api.example.com/download/xyz', { apiKey: 'sk-x' });
    assert.equal(uploadedFilename, 'xyz.pdf');
  });
});

test('uploadPdfFromUrl: explicit filename override wins', async () => {
  let uploadedFilename = null;
  const mock = async (url, opts) => {
    if (url.includes('/files')) {
      if (opts?.body instanceof FormData) uploadedFilename = opts.body.get('file')?.name;
      return { ok: true, json: async () => ({ id: 'file-x' }) };
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await withFetch(mock, async () => {
    await uploadPdfFromUrl('https://x/orig.pdf', { apiKey: 'sk-x', filename: 'my-custom.pdf' });
    assert.equal(uploadedFilename, 'my-custom.pdf');
  });
});

test('uploadPdfFromUrl: rejects when upload response lacks id', async () => {
  const mock = async (url) => {
    if (url.endsWith('.pdf')) return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, json: async () => ({ object: 'file' /* no id */ }) };
  };
  await withFetch(mock, async () => {
    await assert.rejects(
      () => uploadPdfFromUrl('https://x/y.pdf', { apiKey: 'sk-x' }),
      /missing 'id' field/,
    );
  });
});

test('uploadPdfFromUrl: forwards fetchHeaders on the download request', async () => {
  let downloadHeaders = null;
  const mock = async (url, opts) => {
    if (url.endsWith('.pdf')) {
      downloadHeaders = opts?.headers ?? null;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { ok: true, json: async () => ({ id: 'file-x' }) };
  };
  await withFetch(mock, async () => {
    await uploadPdfFromUrl('https://x/y.pdf', {
      apiKey: 'sk-x',
      fetchHeaders: { 'X-Custom-Auth': 'my-token' },
    });
    assert.equal(downloadHeaders['X-Custom-Auth'], 'my-token');
  });
});
