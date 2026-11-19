import { DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export async function createStore(dataDir) {
  const photosDir = path.join(dataDir, 'photos');
  await mkdir(photosDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'photos.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS photos (
      token TEXT PRIMARY KEY, device TEXT NOT NULL, request_id TEXT,
      digest TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      UNIQUE(device, request_id)
    );
    CREATE INDEX IF NOT EXISTS photos_expiry ON photos(expires_at);`);
  const get = db.prepare('SELECT * FROM photos WHERE token = ?');
  const find = db.prepare('SELECT * FROM photos WHERE device = ? AND request_id = ?');
  const insert = db.prepare(`INSERT INTO photos VALUES (:token, :device, :request_id, :digest, :bytes, :width, :height, :created_at, :expires_at)`);
  const remove = db.prepare('DELETE FROM photos WHERE token = ?');
  const filePath = (token) => {
    if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('Invalid token');
    return path.join(photosDir, `${token}.jpg`);
  };
  let cleaning;
  async function sweep(now) {
    let count = 0;
    for (const row of db.prepare('SELECT token FROM photos WHERE expires_at <= ?').all(now)) {
      try { await unlink(filePath(row.token)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      remove.run(row.token);
      count++;
    }
    // Recover files left by a process crash before the database commit.
    for (const name of await readdir(photosDir)) {
      const match = /^([a-f0-9]{48})\.jpg(?:\.partial)?$/.exec(name);
      if (!match || get.get(match[1])) continue;
      const file = path.join(photosDir, name);
      const info = await stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (info && info.mtimeMs < now - 3600000) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return count;
  }
  return {
    get: token => get.get(token), find: (device, requestId) => find.get(device, requestId),
    insert: row => insert.run(row), filePath,
    totalBytes: () => db.prepare('SELECT COALESCE(SUM(bytes), 0) AS size FROM photos').get().size,
    cleanup(now = Date.now()) {
      if (!cleaning) cleaning = sweep(now).finally(() => { cleaning = null; });
      return cleaning;
    },
    close: () => db.close(),
  };
}
