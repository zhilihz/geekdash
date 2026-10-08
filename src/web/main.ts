import './style.css';

const button = document.querySelector<HTMLButtonElement>('#check')!;
const result = document.querySelector<HTMLParagraphElement>('#result')!;

button.addEventListener('click', async () => {
  button.disabled = true;
  result.textContent = '正在检查…';
  try {
    const response = await fetch('/api/health/live', { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!response.ok) throw new Error('连接失败');
    const data = await response.json();
    if (data.status !== 'alive' || typeof data.build?.revision !== 'string') throw new Error('响应无效');
    result.textContent = `后端连接成功 · ${data.build.revision.slice(0, 8)}${data.build.dirty ? ' · 存在未提交改动' : ''}`;
  } catch {
    result.textContent = '后端连接失败，请检查本地服务后重试。';
  } finally {
    button.disabled = false;
  }
});
