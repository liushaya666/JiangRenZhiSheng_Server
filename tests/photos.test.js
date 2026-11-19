import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createStore } from '../src/store.js';
import { request } from 'node:http';

const secret = 'test-device-key-with-at-least-32-characters';
async function setup(t, overrides = {}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'jrzs-server-'));
  let time = Date.now();
  const config = { ...loadConfig({ DEVICE_KEYS: JSON.stringify({ kiosk: secret }), DATA_DIR: folder }), ...overrides };
  const service = await createApp(config, { now: () => time, logger: { error() {} } });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    await service.close();
    await rm(folder, { recursive: true, force: true });
  });
  const image = await sharp({ create: { width: 100, height: 160, channels: 3, background: '#547050' } }).png().toBuffer();
  async function upload(bytes = image, headers = {}, field = 'photo') {
    const form = new FormData();
    form.append(field, new Blob([bytes], { type: 'image/png' }), 'photo.png');
    return fetch(`${base}/api/photos`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, ...headers }, body: form });
  }
  return { ...service, base, folder, config, upload, image, advance: ms => { time += ms; } };
}

test('upload → claim → JPEG download → QR → expiry and physical cleanup', async t => {
  const s = await setup(t);
  const response = await s.upload();
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.match(data.token, /^[a-f0-9]{48}$/);
  assert.equal(data.claimUrl, `http://127.0.0.1:3000/p/${data.token}`);
  assert.equal(data.width, 100);
  assert.equal(data.height, 160);
  const claim = await fetch(`${s.base}/p/${data.token}`);
  assert.equal(claim.status, 200);
  assert.match(await claim.text(), /新造型，带回家/);
  assert.equal(claim.headers.get('cache-control'), 'no-store');
  assert.equal(claim.headers.get('referrer-policy'), 'no-referrer');
  for (const action of ['image', 'download']) {
    const result = await fetch(`${s.base}/api/photos/${data.token}/${action}`);
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type'), /image\/jpeg/);
    assert.match(result.headers.get('content-disposition'), action === 'download' ? /attachment/ : /inline/);
    const meta = await sharp(Buffer.from(await result.arrayBuffer())).metadata();
    assert.equal(meta.width, 100);
    assert.equal(meta.height, 160);
    assert.equal(meta.exif, undefined);
  }
  const qr = await fetch(`${s.base}/api/photos/${data.token}/qr.svg`);
  assert.equal(qr.status, 200);
  assert.match(await qr.text(), /<svg/);
  assert.equal((await fetch(`${s.base}/assets/claim.css`)).status, 200);
  s.advance(s.config.retentionMs + 1);
  for (const suffix of ['', '/image', '/download', '/qr.svg']) {
    assert.equal((await fetch(`${s.base}/api/photos/${data.token}${suffix}`)).status, 404);
  }
  const expired = await fetch(`${s.base}/p/${data.token}`);
  assert.equal(expired.status, 404);
  assert.match(await expired.text(), /已过期/);
  assert.equal(await s.store.cleanup(Date.now() + s.config.retentionMs + 10000), 1);
  assert.equal(s.store.get(data.token), undefined);
  assert.deepEqual(await readdir(path.join(s.folder, 'photos')), []);
});

test('authentication, malformed uploads, invalid formats, size limits and path isolation', async t => {
  const s = await setup(t, { maxUploadBytes: 1024 });
  assert.equal((await s.upload(s.image, { Authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await s.upload(Buffer.from('<svg></svg>'))).status, 415);
  assert.equal((await s.upload(s.image.subarray(0, 32))).status, 415);
  assert.equal((await s.upload(Buffer.alloc(2048))).status, 413);
  assert.equal((await s.upload(s.image, {}, 'wrong')).status, 400);
  assert.equal((await fetch(`${s.base}/api/photos`, { method: 'POST', headers: { Authorization: `Bearer ${secret}` } })).status, 400);
  assert.equal((await fetch(`${s.base}/api/photos/not-a-token/download`)).status, 404);
  assert.equal((await fetch(`${s.base}/data/photos.sqlite`)).status, 404);
  assert.deepEqual(await readdir(path.join(s.folder, 'photos')), []);
});

test('phone save uses the displayed inline image; GET, HEAD and Range responses contain valid image lengths', async t => {
  const s = await setup(t);
  const data = await (await s.upload()).json();
  const page = await (await fetch(`${s.base}/p/${data.token}`)).text();
  assert.match(page, /长按下方照片/);
  assert.match(page, new RegExp(`<img src="/api/photos/${data.token}/image"`));
  assert.doesNotMatch(page, /打开原图|其他保存方式|<a\b|<details\b/);
  const url = `${s.base}/api/photos/${data.token}/image`;
  for (let i = 0; i < 3; i++) {
    const response = await fetch(url, { headers: { 'User-Agent': 'MicroMessenger mobile browser' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /image\/jpeg/);
    assert.match(response.headers.get('content-disposition'), /^inline/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length > 0);
    assert.equal(Number(response.headers.get('content-length')), bytes.length);
    assert.equal(bytes.length, data.bytes);
    assert.equal((await sharp(bytes).metadata()).format, 'jpeg');
  }
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), data.bytes);
  assert.equal((await head.arrayBuffer()).byteLength, 0, 'HEAD reports length but intentionally has no body');
  const range = await fetch(url, { headers: { Range: 'bytes=0-31' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 32);
  assert.equal(range.headers.get('content-range'), `bytes 0-31/${data.bytes}`);
});

test('retries return the same photo, while different content conflicts', async t => {
  const s = await setup(t);
  const headers = { 'Idempotency-Key': 'session_12345678' };
  const first = await s.upload(s.image, headers);
  const data = await first.json();
  const second = await s.upload(s.image, headers);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), data);
  const changed = await sharp(s.image).flip().jpeg().toBuffer();
  assert.equal((await s.upload(changed, headers)).status, 409);
  assert.equal((await s.upload(s.image, { 'Idempotency-Key': '../bad' })).status, 400);
  assert.equal((await readdir(path.join(s.folder, 'photos'))).length, 1);
});

test('device rate limit resets', async t => {
  const s = await setup(t, { uploadsPerMinute: 1 });
  assert.equal((await s.upload()).status, 201);
  const blocked = await s.upload();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');
  s.advance(60001);
  assert.equal((await s.upload()).status, 201);
});

test('storage quota rejects writes without leaving files', async t => {
  const s = await setup(t, { maxStorageBytes: 1 });
  assert.equal((await s.upload()).status, 507);
  assert.equal(s.store.totalBytes(), 0);
  assert.deepEqual(await readdir(path.join(s.folder, 'photos')), []);
});

test('configuration rejects placeholders and untrusted URL parts', () => {
  assert.throws(() => loadConfig({}), /DEVICE_KEYS/);
  assert.throws(() => loadConfig({ DEVICE_KEYS: JSON.stringify({ kiosk: 'replace-with-a-random-secret-at-least-32-chars' }) }), /DEVICE_KEYS/);
  assert.throws(() => loadConfig({ PUBLIC_BASE_URL: 'https://example.com/path' }), /PUBLIC_BASE_URL/);
  assert.throws(() => loadConfig({ DEVICE_KEYS: JSON.stringify({ kiosk: secret }), PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ DEVICE_KEYS: JSON.stringify({ kiosk: secret, other: secret }) }), /不同密钥/);
});

test('slow upload holds a capacity slot until completed', async t => {
  const s = await setup(t, { maxConcurrentUploads: 1 });
  const boundary = 'test-upload-boundary';
  const client = request(`${s.base}/api/photos`, { method: 'POST', headers: {
    Authorization: `Bearer ${secret}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`,
  } });
  client.on('error', () => {});
  const firstResponse = new Promise(resolve => client.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }));
  client.write(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`);
  // FIFO requests over the same event loop: health response confirms prior headers were processed.
  await fetch(`${s.base}/healthz`);
  try {
    const blocked = await s.upload();
    assert.equal(blocked.status, 503);
    assert.equal(blocked.headers.get('retry-after'), '5');
    client.write(s.image);
    client.end(`\r\n--${boundary}--\r\n`);
    assert.equal(await firstResponse, 201);
  } finally { client.destroy(); }
});

test('SQLite survives reopen and startup cleanup removes expired photos', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'jrzs-store-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const token = 'a'.repeat(48), createdAt = Date.now();
  let store = await createStore(folder);
  store.insert({ token, device: 'kiosk', request_id: 'persist_1234', digest: 'hash', bytes: 3,
    width: 1, height: 1, created_at: createdAt, expires_at: createdAt + 1000 });
  store.close();
  store = await createStore(folder);
  try {
    assert.equal(store.get(token).request_id, 'persist_1234');
    assert.equal(store.find('kiosk', 'persist_1234').token, token);
    assert.equal(await store.cleanup(createdAt + 1001), 1);
    assert.equal(store.totalBytes(), 0);
  } finally { store.close(); }
});
