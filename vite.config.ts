import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// 阶段说明以原面板为唯一来源；构建时只提取静态定义，不打包其示例项目或本地存储脚本。
const stageSource = readFileSync(new URL('./geekdashdesktop/projects-data.js', import.meta.url), 'utf8').match(/const STAGES = (\[[\s\S]*?\n  \]);/);
if (!stageSource) throw new Error('原面板阶段定义未找到');
const stages = runInNewContext(stageSource[1], Object.create(null), { timeout: 1000 });
if (!Array.isArray(stages) || stages.length !== 7 || stages.some((stage, index) => stage.id !== index + 1)) throw new Error('原面板七阶段定义无效');
const themeInit = readFileSync(new URL('./src/web/shared/theme-init.js', import.meta.url), 'utf8');

export default defineConfig({
  plugins: [
    { name: 'geekdash-initial-theme', transformIndexHtml: { order: 'pre', handler: () => [{ tag: 'script', attrs: { 'data-theme-init': '' }, children: themeInit, injectTo: 'head-prepend' }] } },
    { name: 'geekdash-shared-design', transformIndexHtml: { order: 'post', handler(html, context) {
      if (!context.bundle) return html;
      // Vite 会提前抽取共享 CSS；统一设计必须在各页旧样式之后生效。
      const design = Object.values(context.bundle).find(asset => asset.type === 'asset' && asset.fileName.endsWith('.css') && String(asset.source).includes('--app-header-height:'));
      const link = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].find(match => design && match[0].includes(`/${design.fileName}`));
      if (!link) throw new Error('页面缺少统一设计样式');
      return html.replace(link[0], '').replace('</head>', `  ${link[0]}\n</head>`);
    } } },
  ],
  define: { __GEEKDASH_STAGES__: JSON.stringify(stages), __GEEKDASH_RELEASE__: JSON.stringify(process.env.GEEKDASH_SOURCE_REVISION ?? '') },
  root: fileURLToPath(new URL('./src/web/', import.meta.url)),
  envDir: false,
  build: {
    rollupOptions: {
      input: ['index.html', 'project-detail.html', 'login.html', 'project-new.html', 'project-checks.html', 'settings.html', 'data-manage.html', 'project-status-summary.html', 'imports.html', 'project-space.html', 'accounts.html', 'profile.html', 'register.html', 'password.html'].map(path => fileURLToPath(new URL(`./src/web/${path}`, import.meta.url))),
    },
    outDir: fileURLToPath(new URL('./dist.candidate/web/', import.meta.url)),
    emptyOutDir: true,
  },
});
