import { isIP } from 'node:net';
import type { RuntimeProfile } from './runtime-database.js';

export function readConfig(env = process.env) {
  const host = env.HOST ?? '127.0.0.1';
  const port = env.PORT ?? '3000';
  if (!isIP(host)) throw Object.assign(new Error('HOST 必须为有效 IP 地址'), { code: 'APP_CONFIG_INVALID', field: 'HOST' });
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw Object.assign(new Error('PORT 必须为 1～65535 的整数'), { code: 'APP_CONFIG_INVALID', field: 'PORT' });
  }
  const databaseProfile = env.GEEKDASH_DB_PROFILE ?? 'dev_app';
  if (!['dev_app', 'test_app'].includes(databaseProfile)) throw Object.assign(new Error('GEEKDASH_DB_PROFILE 必须为 dev_app 或 test_app'), { code: 'APP_CONFIG_INVALID', field: 'GEEKDASH_DB_PROFILE' });
  return { host, port: Number(port), databaseProfile: databaseProfile as RuntimeProfile };
}
