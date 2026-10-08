import { isIP } from 'node:net';

export function readConfig(env = process.env) {
  const host = env.HOST ?? '127.0.0.1';
  const port = env.PORT ?? '3000';
  if (!isIP(host)) throw new Error('HOST 必须为有效 IP 地址');
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('PORT 必须为 1～65535 的整数');
  }
  return { host, port: Number(port) };
}
