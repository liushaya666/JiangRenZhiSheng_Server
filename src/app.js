import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFile, rename, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { photoPage } from './page.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (status, message) => Object.assign(new Error(message), { status });

export async function createApp(config, { now = Date.now, logger = console } = {}) {
  const store = await createStore(config.dataDir);
  try { await store.cleanup(now()); }
  catch (error) { store.close(); throw error; }
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  let activeUploads = 0, reservedBytes = 0;
  const requests = new Map(), pending = new Set();
  const credentials = Object.entries(config.devices).map(([device, key]) => [device, createHash('sha256').update(key).digest()]);
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    next();
  });
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/assets/claim.css', (req, res) => res.sendFile(path.join(root, 'public', 'claim.css')));
  app.get('/', (req, res) => res.type('html').send(photoPage(null)));

  function authenticate(req, res, next) {
    const match = /^Bearer ([^\s]{32,512})$/.exec(req.get('authorization') || '');
    if (!match) return next(fail(401, '设备凭证无效。'));
    const digest = createHash('sha256').update(match[1]).digest();
    const device = credentials.find(([, key]) => timingSafeEqual(digest, key))?.[0];
    if (!device) return next(fail(401, '设备凭证无效。'));
    req.device = device;
    const time = now();
    let entry = requests.get(device);
    if (!entry || time >= entry.resetAt) { entry = { count: 0, resetAt: time + 60000 }; requests.set(device, entry); }
    if (++entry.count > config.uploadsPerMinute) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - time) / 1000))));
      return next(fail(429, '上传过于频繁，请稍后重试。'));
    }
    next();
  }
  function capacity(req, res, next) {
    if (activeUploads >= config.maxConcurrentUploads) { res.set('Retry-After', '5'); return next(fail(503, '上传繁忙，请稍后重试。')); }
    activeUploads++;
    let released = false;
    req.releaseUpload = () => { if (!released) { released = true; activeUploads--; } };
    next();
  }
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0, parts: 1, headerPairs: 50 },
  }).single('photo');
  function parseUpload(req, res, next) {
    upload(req, res, (error) => {
      if (error) { req.releaseUpload(); next(error); }
      else next();
    });
  }
  function description(row) {
    const prefix = `${config.baseUrl}/api/photos/${row.token}`;
    return { token: row.token, claimUrl: `${config.baseUrl}/p/${row.token}`,
      imageUrl: `${prefix}/image`, downloadUrl: `${prefix}/download`, qrCodeUrl: `${prefix}/qr.svg`,
      expiresAt: new Date(row.expires_at).toISOString(), width: row.width, height: row.height, bytes: row.bytes };
  }
  app.post('/api/photos', authenticate, capacity, parseUpload, async (req, res, next) => {
    let temporary, final, committed = false, reservation = 0, lock;
    try {
      if (!req.file) throw fail(400, '请通过 multipart/form-data 的 photo 字段上传一张照片。');
      const requestId = req.get('idempotency-key') || null;
      if (requestId && !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) throw fail(400, 'Idempotency-Key 需要 8～128 位字母、数字、下划线或连字符。');
      const digest = createHash('sha256').update(req.file.buffer).digest('hex');
      if (requestId) {
        const prior = store.find(req.device, requestId);
        if (prior) {
          if (prior.digest !== digest) throw fail(409, '同一个上传编号不能用于不同照片。');
          if (prior.expires_at <= now()) throw fail(410, '该次上传已过期，请使用新的上传编号。');
          await access(store.filePath(prior.token));
          return res.json(description(prior));
        }
        lock = `${req.device}:${requestId}`;
        if (pending.has(lock)) { lock = null; res.set('Retry-After', '3'); throw fail(409, '该照片正在上传，请稍后使用相同编号重试。'); }
        pending.add(lock);
      }
      let output;
      try {
        const options = { limitInputPixels: 32000000, failOn: 'warning' };
        const metadata = await sharp(req.file.buffer, options).metadata();
        if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) throw new Error('format');
        output = await sharp(req.file.buffer, options).rotate().resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      } catch { throw fail(415, '照片无法读取，请上传完整的 PNG、JPG 或静态 WebP 图片（最多 3200 万像素）。'); }
      if (store.totalBytes() + reservedBytes + output.data.length > config.maxStorageBytes) throw fail(507, '照片存储空间不足，请联系工作人员。');
      reservation = output.data.length;
      reservedBytes += reservation;
      const token = randomBytes(24).toString('hex');
      final = store.filePath(token); temporary = `${final}.partial`;
      await writeFile(temporary, output.data, { flag: 'wx', mode: 0o600 });
      await rename(temporary, final);
      const createdAt = now();
      const row = { token, device: req.device, request_id: requestId, digest, bytes: output.data.length,
        width: output.info.width, height: output.info.height, created_at: createdAt, expires_at: createdAt + config.retentionMs };
      store.insert(row);
      committed = true;
      res.status(201).json(description(row));
    } catch (error) { next(error); }
    finally {
      // Keep the capacity slot until all rollback work has finished.
      try {
        if (!committed) {
          for (const file of [temporary, final].filter(Boolean)) {
            await unlink(file).catch(error => { if (error.code !== 'ENOENT') logger.error('Upload rollback failed:', error.code); });
          }
        }
      } finally {
        reservedBytes -= reservation;
        if (lock) pending.delete(lock);
        req.releaseUpload();
      }
    }
  });

  async function photo(req, res, next) {
    const token = req.params.token;
    const row = /^[a-f0-9]{48}$/.test(token) ? store.get(token) : null;
    let present = false;
    if (row && row.expires_at > now()) {
      try { await access(store.filePath(token)); present = true; }
      catch (error) { if (error.code !== 'ENOENT') return next(error); }
    }
    if (!present) {
      if (req.path.startsWith('/p/')) return res.status(404).type('html').send(photoPage(null));
      return next(fail(404, '照片不存在或已过期。'));
    }
    req.photo = row;
    next();
  }
  app.get('/p/:token', photo, (req, res) => res.type('html').send(photoPage(req.photo)));
  app.get('/api/photos/:token', photo, (req, res) => res.json(description(req.photo)));
  app.get('/api/photos/:token/qr.svg', photo, async (req, res) => {
    const svg = await QRCode.toString(description(req.photo).claimUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 320 });
    res.type('image/svg+xml').send(svg);
  });
  for (const action of ['image', 'download']) {
    app.get(`/api/photos/:token/${action}`, photo, (req, res, next) => {
      res.set('Content-Disposition', `${action === 'download' ? 'attachment' : 'inline'}; filename="jiangrenzhisheng.jpg"`);
      res.sendFile(store.filePath(req.photo.token), { cacheControl: false, lastModified: false, dotfiles: 'deny' }, error => {
        if (error) next(error.code === 'ENOENT' ? fail(404, '照片不存在或已过期。') : error);
      });
    });
  }
  app.use((req, res, next) => next(fail(404, '请求的地址不存在。')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = error.status || 500, message = error.message;
    if (error instanceof multer.MulterError) {
      status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      message = status === 413 ? '照片超过上传大小限制。' : '请仅通过 photo 字段上传一张照片，不要附带其他字段。';
    }
    if (status >= 500 && ![503, 507].includes(status)) {
      logger.error('Request failed:', error.code || error.name);
      message = '服务器暂时无法处理，请稍后重试。';
    }
    res.status(status).json({ error: { message } });
  });
  const timer = setInterval(() => store.cleanup(now()).catch(error => logger.error('Cleanup failed:', error.code || error.name)), config.cleanupMs);
  timer.unref();
  return { app, store, async close() { clearInterval(timer); try { await store.cleanup(now()); } finally { store.close(); } } };
}
