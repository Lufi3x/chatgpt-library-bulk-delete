const assert = require('node:assert');
const { listImages, selectItems, trashItems, formatSize } = require('./content.js');

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const item = (n, extra = {}) => ({
  id: `lib${n}`, file_id: `file${n}`, directory_id: 'dir', file_name: `${n}.png`, access_kind: 'owned',
  is_project: false, gizmo_id: null, file_size_bytes: 10, record_creation_time: '2026-06-15T12:00:00Z', ...extra,
});

function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, options) => {
    if (url === '/api/auth/session') return json({ accessToken: 't' });
    const body = JSON.parse(options.body);
    calls.push({ url, body, auth: options.headers.Authorization });
    return handler(url, body, calls.length);
  };
  return calls;
}

(async () => {
  // Scan follows the cursor until it runs out.
  let calls = mockFetch((_, body) => json(body.cursor ? { items: [item(2)], cursor: null } : { items: [item(1)], cursor: 'next' }));
  assert.deepStrictEqual((await listImages()).map((i) => i.id), ['lib1', 'lib2']);
  assert.strictEqual(calls[1].body.cursor, 'next');
  assert.strictEqual(calls[0].body.trashed_only, false);
  assert.strictEqual(calls[0].auth, 'Bearer t');

  // Project, GPT and shared files are never selected; the date cut-off is exclusive.
  const mixed = [item(1), item(2, { is_project: true }), item(3, { gizmo_id: 'g' }), item(4, { access_kind: 'shared' })];
  assert.deepStrictEqual(selectItems(mixed, '').map((i) => i.id), ['lib1']);
  assert.strictEqual(selectItems(mixed, '2026-06-15').length, 0);
  assert.strictEqual(selectItems(mixed, '2026-06-17').length, 1);

  // Batches of 25 (server maximum) with exactly the request shape ChatGPT's own UI sends.
  const many = Array.from({ length: 120 }, (_, n) => item(n));
  calls = mockFetch((_, body) => json({ success: true, files: body.files.map((f) => ({ library_file_id: f.library_file_id, success: true })) }));
  assert.deepStrictEqual(await trashItems(many, { pause: 0 }), { deleted: 120, failed: 0 });
  assert.deepStrictEqual(calls.map((c) => c.body.files.length), [25, 25, 25, 25, 20]);
  assert.strictEqual(calls[0].url, '/backend-api/files/library/files/delete-batch');
  assert.deepStrictEqual(calls[0].body.files[0], { library_file_id: 'lib0', file_id: 'file0', parent_directory_id: 'dir', file_name: '0.png' });

  // A file the server refuses is reported, not counted as deleted.
  mockFetch(() => json({ files: [{ success: true }, { success: false }] }));
  assert.deepStrictEqual(await trashItems([item(1), item(2)], { pause: 0 }), { deleted: 1, failed: 1 });

  // Rate limit: waits and retries the same batch.
  calls = mockFetch((_, body, n) => (n === 1
    ? json({}, 429, { 'Retry-After': '0' })
    : json({ files: body.files.map(() => ({ success: true })) })));
  assert.deepStrictEqual(await trashItems([item(1)], { pause: 0 }), { deleted: 1, failed: 0 });
  assert.strictEqual(calls.length, 2);

  // A hard error stops the run instead of continuing blindly.
  calls = mockFetch(() => json({}, 403));
  await assert.rejects(trashItems(many, { pause: 0 }), /403/);
  assert.strictEqual(calls.length, 1);

  // Stop takes effect between batches.
  let stop = false;
  calls = mockFetch((_, body) => { stop = true; return json({ files: body.files.map(() => ({ success: true })) }); });
  assert.deepStrictEqual(await trashItems(many, { pause: 0, shouldStop: () => stop }), { deleted: 25, failed: 0 });
  assert.strictEqual(calls.length, 1);

  assert.strictEqual(formatSize(1024 ** 3 * 1.5), '1.50 GB');
  assert.strictEqual(formatSize(1024 ** 2 * 2), '2.0 MB');
  console.log('ok');
})().catch((error) => { console.error(error); process.exit(1); });
