import { execFileSync } from 'node:child_process';
import { access, cp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const candidate = new URL('../dist.candidate/', import.meta.url);
const current = new URL('../dist/', import.meta.url);
const previous = new URL('../dist.previous/', import.meta.url);

try {
  let revision = process.env.GEEKDASH_SOURCE_REVISION;
  let dirty = process.env.GEEKDASH_SOURCE_DIRTY;
  if (!revision || !dirty) {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() ? 'true' : 'false';
  }
  if (!/^[a-f0-9]{40}$/.test(revision) || !['true', 'false'].includes(dirty)) {
    throw new Error('源码版本或未提交状态无效');
  }
  await rm(candidate, { recursive: true, force: true });
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json', '--noEmit'], { stdio: 'inherit' });
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.web.json', '--noEmit'], { stdio: 'inherit' });
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json'], { stdio: 'inherit' });
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit' });
  await cp(new URL('../migrations/', import.meta.url), new URL('migrations/', candidate), { recursive: true });
  const schemaVersion = JSON.parse(await readFile(new URL('migrations/0003-node-recovery.json', candidate), 'utf8')).version;
  if (schemaVersion !== '0003-node-recovery') throw new Error('迁移资源目标版本无效');
  await access(new URL('server/start.js', candidate));
  const html = await readFile(new URL('web/index.html', candidate), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]);
  if (!assets.some(path => path.endsWith('.js')) || !assets.some(path => path.endsWith('.css'))) {
    throw new Error('前端脚本或样式产物缺失');
  }
  for (const asset of assets) await access(new URL(`web${asset}`, candidate));
  const build = { revision, dirty: dirty === 'true', builtAt: new Date().toISOString(), stage: 'project-nodes-compatible', schemaVersion };
  await writeFile(new URL('build-info.json', candidate), JSON.stringify(build, null, 2) + '\n');
  const { createApp } = await import(new URL('server/app.js', candidate));
  const app = await createApp();
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    for (const path of ['/', '/GeekDash.html', '/project-detail.html', '/api/health/live', ...assets]) {
      const response = await fetch(origin + path, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`候选产物 HTTP 核验失败：${path}`);
      await response.arrayBuffer();
    }
  } finally {
    await app.close();
  }
  await rm(previous, { recursive: true, force: true });
  let moved = false;
  try {
    await rename(current, previous);
    moved = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(candidate, current); }
  catch (error) { if (moved) await rename(previous, current); throw error; }
  console.log(JSON.stringify({ status: 'built', output: 'dist', build, businessReady: false }));
} catch (error) {
  console.error('构建失败，未提升候选产物：', error.message);
  process.exitCode = 1;
}
