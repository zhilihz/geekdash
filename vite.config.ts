import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// 阶段说明以原面板为唯一来源；构建时只提取静态定义，不打包其示例项目或本地存储脚本。
const stageSource = readFileSync(new URL('./geekdashdesktop/projects-data.js', import.meta.url), 'utf8').match(/const STAGES = (\[[\s\S]*?\n  \]);/);
if (!stageSource) throw new Error('原面板阶段定义未找到');
const stages = runInNewContext(stageSource[1], Object.create(null), { timeout: 1000 });
if (!Array.isArray(stages) || stages.length !== 7 || stages.some((stage, index) => stage.id !== index + 1)) throw new Error('原面板七阶段定义无效');

export default defineConfig({
  define: { __GEEKDASH_STAGES__: JSON.stringify(stages) },
  root: fileURLToPath(new URL('./src/web/', import.meta.url)),
  envDir: false,
  build: {
    rollupOptions: {
      input: ['index.html', 'project-detail.html', 'login.html', 'project-new.html', 'project-checks.html', 'settings.html'].map(path => fileURLToPath(new URL(`./src/web/${path}`, import.meta.url))),
    },
    outDir: fileURLToPath(new URL('./dist.candidate/web/', import.meta.url)),
    emptyOutDir: true,
  },
});
