import { createApp } from './app.js';
import { readConfig } from './infrastructure/config.js';

try {
  const config = readConfig();
  const app = await createApp();
  const close = async () => {
    const timeout = setTimeout(() => process.exit(1), 5000);
    timeout.unref();
    try {
      await app.close();
      clearTimeout(timeout);
    } catch (error) {
      app.log.error(error, '关闭失败');
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  await app.listen(config);
} catch (error) {
  console.error(error instanceof Error ? error.message : '启动失败');
  process.exitCode = 1;
}
