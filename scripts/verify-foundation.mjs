import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { readConfig } from '../dist/server/infrastructure/config.js';

assert.throws(() => readConfig({ PORT: '3000oops' }), /PORT/);
assert.throws(() => readConfig({ PORT: '65536' }), /PORT/);
assert.throws(() => readConfig({ HOST: 'invalid host' }), /HOST/);

const before = await readFile(new URL('../dist/build-info.json', import.meta.url), 'utf8');
assert.throws(() => execFileSync(process.execPath, ['scripts/build.mjs'], {
  env: { ...process.env, GEEKDASH_SOURCE_REVISION: 'invalid', GEEKDASH_SOURCE_DIRTY: 'true' },
  stdio: 'pipe',
}));
assert.equal(await readFile(new URL('../dist/build-info.json', import.meta.url), 'utf8'), before);
const fixture = new URL('../src/server/foundation-invalid.fixture.ts', import.meta.url);
let created = false;
try {
  await writeFile(fixture, 'const invalid: number = "type error";\n', { flag: 'wx' });
  created = true;
  assert.throws(() => execFileSync(process.execPath, ['scripts/build.mjs'], {
    env: { ...process.env, GEEKDASH_SOURCE_REVISION: JSON.parse(before).revision, GEEKDASH_SOURCE_DIRTY: 'true' },
    stdio: 'pipe',
  }), error => error.stdout.toString().includes('foundation-invalid.fixture.ts'));
} finally {
  if (created) await unlink(fixture);
}
assert.equal(await readFile(new URL('../dist/build-info.json', import.meta.url), 'utf8'), before);

const app = await createApp();
try {
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const live = await fetch(`${origin}/api/health/live`);
  assert.equal(live.status, 200);
  assert.deepEqual((await live.json()).build, JSON.parse(before));
  const ready = await fetch(`${origin}/api/health/ready`);
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).reason, 'database_not_implemented');
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /GeekDash 工程验证/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]);
  assert.ok(assets.length >= 2);
  for (const asset of assets) {
    const response = await fetch(origin + asset);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 0);
  }
  assert.equal((await fetch(`${origin}/.env`)).status, 403);
  for (const path of ['/api/projects', '/AGENTS.md', '/src/server/start.ts', '/build-info.json']) {
    assert.equal((await fetch(origin + path)).status, 404);
  }
  console.log('通过：真实 HTTP、构建资源、未就绪反馈、源码隔离、无效配置与失败构建保留旧产物。');
} finally {
  await app.close();
}
