// 仅缓存显示颜色；首屏不读取账号、个人草稿或业务数据。
(() => {
  let theme = 'dark';
  try {
    const saved = localStorage.getItem('geekdash_theme');
    if (['dark', 'light', 'warm'].includes(saved)) theme = saved;
  } catch {}
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
})();
