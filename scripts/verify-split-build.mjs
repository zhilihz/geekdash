import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--web-image', '--api-image'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('用法：node scripts/verify-split-build.mjs --web-image IMAGE --api-image IMAGE');
  options[args[i]] = args[i + 1];
}
assert.ok(options['--web-image'] && options['--api-image'], '必须明确提供两个已构建的隔离验收镜像');
const docker = (...values) => execFileSync('docker', values, { encoding: 'utf8', timeout: 120000 }).trim();
const id = randomUUID().slice(0, 8), containers = [];
let requests = 0;
function start(kind, image, port, extra) {
  const name = `geekdash-split-${id}-${kind}`;
  containers.push(name);
  docker('run', '-d', '--pull=never', '--name', name, '--label', 'geekdash.verification=split-build', '--read-only', '--tmpfs', '/tmp', '-p', `127.0.0.1::${port}`, ...extra, image, ...(kind === 'api' ? ['--input-type=module', '-e', "import{createApp}from'./dist/server/app.js';const app=await createApp();process.on('SIGTERM',()=>app.close());await app.listen({host:'0.0.0.0',port:3000});"] : []));
  const state = JSON.parse(docker('inspect', name))[0];
  return { name, origin: `http://127.0.0.1:${state.NetworkSettings.Ports[`${port}/tcp`][0].HostPort}` };
}
async function request(origin, path, status = 200) {
  const response = await fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, status, `${path} 状态`);
  requests++;
  return response;
}
async function wait(origin, path) {
  for (let i = 0; i < 30; i++) {
    try { await (await request(origin, path)).arrayBuffer(); return; }
    catch { await delay(300); }
  }
  throw new Error(`容器未能启动：${path}`);
}

try {
  const web = start('web', options['--web-image'], 8080, ['--tmpfs', '/run/geekdash-maintenance:uid=101,gid=101,mode=0700']);
  const api = start('api', options['--api-image'], 3000, ['--entrypoint', 'node']);
  await Promise.all([wait(web.origin, '/healthz'), wait(api.origin, '/api/health/live')]);
  const webBuild = await (await request(web.origin, '/build-info.json')).json();
  const apiBuild = (await (await request(api.origin, '/api/health/live')).json()).build;
  assert.deepEqual(webBuild, apiBuild, '前后端必须来自同一构建');

  const pages = (await readdir(new URL('../src/web/', import.meta.url))).filter(path => path.endsWith('.html')).sort();
  const assets = new Set();
  for (const page of ['/', '/GeekDash.html', ...pages.map(page => '/' + page)]) {
    const response = await request(web.origin, page);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(response.headers.get('cache-control'), /no-cache/);
    const html = await response.text();
    for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)) assets.add(match[1]);
  }
  assert.ok(assets.size > 0);
  for (const path of assets) {
    const response = await request(web.origin, path);
    assert.match(response.headers.get('cache-control'), /immutable/);
    assert.ok(!(response.headers.get('content-type') ?? '').includes('text/html'), '资源不能回退为HTML');
    await response.arrayBuffer();
  }
  const alias = await request(web.origin, '/chip-statistics.html?chip=1', 302);
  assert.equal(new URL(alias.headers.get('location'), web.origin).pathname, '/project-status-summary.html');
  assert.equal(new URL(alias.headers.get('location'), web.origin).search, '?chip=1');
  await (await request(web.origin, '/assets/missing.js', 404)).arrayBuffer();
  for (const path of ['/api', '/api/projects', '/api/events']) {
    const response = await request(web.origin, path, 404);
    assert.equal((await response.json()).code, 'API_ROUTE_MISMATCH');
  }
  for (const path of ['/', '/index.html', '/build-info.json', '/GeekDash.html']) await (await request(api.origin, path, 404)).arrayBuffer();
  assert.equal((await (await request(api.origin, '/api/health/ready', 503)).json()).reason, 'database_not_configured');

  docker('exec', web.name, 'touch', '/run/geekdash-maintenance/enabled');
  const maintenance = await request(web.origin, '/', 503);
  assert.equal(maintenance.headers.get('x-geekdash-maintenance'), 'on');
  assert.match(await maintenance.text(), /GeekDash 正在更新/);
  await (await request(web.origin, '/healthz')).arrayBuffer();
  await (await request(web.origin, '/build-info.json')).arrayBuffer();
  docker('exec', web.name, 'rm', '/run/geekdash-maintenance/enabled');
  await (await request(web.origin, '/')).arrayBuffer();

  const paths = ['dist/web', 'dist/server/static.js', 'node_modules/@fastify/static', 'node_modules/typescript', 'node_modules/vite', 'src', 'docs', '.git', '/usr/sbin/mysqld', '/usr/bin/mysqld'];
  docker('exec', api.name, 'node', '--input-type=module', '-e', `import assert from'node:assert/strict';import{existsSync}from'node:fs';for(const p of ${JSON.stringify(paths)})assert.equal(existsSync(p),false,p);assert.ok(existsSync('dist/migrations'));assert.equal(process.getuid(),1000);`);
  assert.equal(docker('exec', web.name, 'id', '-u'), '101');
  const images = Object.fromEntries(['web', 'api'].map(kind => {
    const fact = JSON.parse(docker('image', 'inspect', options[`--${kind}-image`]))[0];
    assert.equal(fact.Config.Labels['org.opencontainers.image.revision'], webBuild.revision, '镜像标签与构建版本一致');
    return [kind, { id: fact.Id, bytes: fact.Size, architecture: fact.Architecture }];
  }));
  console.log(JSON.stringify({ status: 'verified', scope: '静态前端与无数据库后端镜像边界；不含业务验收或RDS验证', requests, pages: pages.length, assets: assets.size, build: webBuild, images }, null, 2));
} finally {
  for (const name of containers.reverse()) {
    try { docker('stop', '--time', '5', name); } catch {}
    try { docker('rm', name); } catch {}
  }
}
