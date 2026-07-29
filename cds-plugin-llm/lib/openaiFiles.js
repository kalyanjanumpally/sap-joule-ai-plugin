// OpenAI Files API helpers. Currently only PDFs are wired since chat.completions
// file support is what motivated this — extend when more MIME types are needed.
//
// Requires Node 18+ for global fetch/FormData/Blob (which the plugin already
// requires per package.json engines).

/**
 * Fetch a PDF from `url`, upload to the Files API at
 * `<baseUrl>/files` (default OpenAI), and return a plugin-shape document
 * block referencing the returned `file_id`. Pass the block into any
 * OpenAI-compatible chat request the same way you'd pass a base64 PDF —
 * the provider translates the file_id source into
 * `{type:'file', file:{file_id}}` for the chat.completions call.
 *
 *   const doc = await uploadPdfFromUrl('https://example.com/spec.pdf', {
 *     apiKey: process.env.OPENAI_API_KEY,
 *   });
 *   await openai.chat({
 *     messages: [{ role: 'user', content: [doc, {type:'text', text:'summarize'}] }],
 *   });
 *
 * Only works against endpoints that speak OpenAI's Files API (real OpenAI,
 * Azure OpenAI). Groq / DeepSeek / Together / etc. don't expose /v1/files
 * — the upload will 404.
 */
async function uploadPdfFromUrl(url, options = {}) {
  const {
    apiKey,
    baseUrl = 'https://api.openai.com/v1',
    purpose = 'user_data',
    filename,
    fetchHeaders,
  } = options;

  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('uploadPdfFromUrl: url is required');
  }
  if (!apiKey) throw new Error('uploadPdfFromUrl: apiKey is required');

  const downloadResp = await fetch(url, { headers: fetchHeaders });
  if (!downloadResp.ok) {
    throw new Error(`uploadPdfFromUrl: failed to fetch ${url} — ${downloadResp.status} ${downloadResp.statusText}`);
  }
  const buf = Buffer.from(await downloadResp.arrayBuffer());
  const inferredName = filename ?? inferFilenameFromUrl(url);

  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/pdf' }), inferredName);
  form.append('purpose', purpose);

  const cleanBase = baseUrl.replace(/\/$/, '');
  const uploadResp = await fetch(`${cleanBase}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!uploadResp.ok) {
    const text = await uploadResp.text().catch(() => '');
    throw new Error(`uploadPdfFromUrl: Files API upload failed — ${uploadResp.status} ${uploadResp.statusText}${text ? `: ${text}` : ''}`);
  }
  const meta = await uploadResp.json();
  if (!meta?.id) {
    throw new Error(`uploadPdfFromUrl: Files API response missing 'id' field`);
  }
  return {
    type: 'document',
    source: { type: 'file_id', file_id: meta.id, mediaType: 'application/pdf' },
  };
}

function inferFilenameFromUrl(url) {
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').pop() || 'document.pdf';
    return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
  } catch {
    return 'document.pdf';
  }
}

module.exports = { uploadPdfFromUrl };
