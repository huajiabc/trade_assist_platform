import 'dotenv/config';
import { createApp } from './app';
import { readServerConfig } from './config';

try {
  const config = readServerConfig();
  const app = createApp({ config });
  const server = app.listen(config.port, config.host, () => {
    console.log(`PA/SMC Assistant API: http://${config.host}:${config.port}`);
  });
  server.on('error', () => {
    console.error('服务端启动失败，请检查 HOST、PORT 是否有效及端口是否被占用。');
    process.exitCode = 1;
  });
} catch {
  // Configuration can contain secrets: never log the originating error/object.
  console.error('服务端配置无效，请对照 .env.example 检查环境变量。');
  process.exitCode = 1;
}
