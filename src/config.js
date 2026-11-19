import path from 'node:path';

function integer(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}～${max} 之间的整数`);
  return value;
}

export function loadConfig(env = process.env) {
  const url = new URL(env.PUBLIC_BASE_URL || 'http://127.0.0.1:3000');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_BASE_URL 必须是无路径、无认证参数的 HTTP(S) 地址');
  }
  let devices;
  try { devices = JSON.parse(env.DEVICE_KEYS || '{}'); }
  catch { throw new Error('DEVICE_KEYS 格式错误，需要 JSON 对象：{"experience-01":"设备密钥"}，请检查设备名称、冒号及英文双引号'); }
  if (!devices || Array.isArray(devices) || typeof devices !== 'object' || !Object.keys(devices).length ||
      Object.entries(devices).some(([id, key]) => !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof key !== 'string' || key.length < 32 || key.length > 512 || /\s/.test(key) || key.startsWith('replace-'))) {
    throw new Error('请设置 DEVICE_KEYS，每台设备使用不少于 32 字符的独立随机密钥，并替换示例值');
  }
  if (new Set(Object.values(devices)).size !== Object.keys(devices).length) throw new Error('DEVICE_KEYS 中每台设备必须使用不同密钥');
  const trustProxy = env.TRUST_PROXY || 'false';
  if (!['false', 'loopback'].includes(trustProxy)) throw new Error('TRUST_PROXY 仅支持 false 或 loopback');
  return {
    host: env.HOST || '127.0.0.1', port: integer(env, 'PORT', 3000, 1, 65535),
    baseUrl: url.origin, devices, dataDir: path.resolve(env.DATA_DIR || './data'),
    retentionMs: integer(env, 'RETENTION_HOURS', 72, 1, 8760) * 3600000,
    maxUploadBytes: integer(env, 'MAX_UPLOAD_MB', 30, 1, 100) * 1024 * 1024,
    maxStorageBytes: integer(env, 'MAX_STORAGE_MB', 10240, 1, 1000000) * 1024 * 1024,
    uploadsPerMinute: integer(env, 'UPLOADS_PER_MINUTE', 10, 1, 1000),
    maxConcurrentUploads: integer(env, 'MAX_CONCURRENT_UPLOADS', 2, 1, 16),
    cleanupMs: integer(env, 'CLEANUP_INTERVAL_MINUTES', 10, 1, 1440) * 60000,
    trustProxy: trustProxy === 'loopback' ? 'loopback' : false,
  };
}
