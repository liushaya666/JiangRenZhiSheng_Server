import { loadConfig } from './config.js';
import { createApp } from './app.js';

try {
  const config = loadConfig();
  const service = await createApp(config);
  const server = service.app.listen(config.port, config.host, () => {
    console.log(`照片服务已启动：http://${config.host}:${config.port}`);
    console.log(`领取链接使用：${config.baseUrl}`);
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 150000);
    deadline.unref();
    server.close(async error => {
      try { await service.close(); }
      catch (closeError) { console.error('关闭失败：', closeError.code || closeError.name); process.exitCode = 1; }
      if (error) process.exitCode = 1;
      clearTimeout(deadline);
    });
    server.closeIdleConnections();
  };
  server.on('error', async error => { console.error('监听失败：', error.code); await service.close(); process.exitCode = 1; });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  console.error('启动失败：', error.message);
  process.exitCode = 1;
}
