import { esc, type Project } from './api';

type StatusSource = Pick<Project, 'statusDesc' | 'statusEntries'>;
function lines(project: StatusSource) {
  const text = project.statusDesc.replace(/\r\n?/g, '\n');
  const saved = project.statusEntries;
  const entries = saved?.map(entry => entry.text).join('\n') === text ? saved : text.split('\n').map(text => ({ text, date: '' }));
  return entries.map(entry => {
    const date = entry.date ? new Date(entry.date) : undefined;
    return { ...entry, stamp: date && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).format(date) : '' };
  });
}
export function statusHtml(project: StatusSource) {
  return lines(project).map(entry => `<p class="status-line">${esc(entry.text) || '<br>'}${entry.stamp ? `<time class="status-line-date" datetime="${esc(entry.date)}">　${esc(entry.stamp)}</time>` : ''}</p>`).join('');
}
export function statusText(project: StatusSource) {
  return lines(project).map(entry => entry.text + (entry.stamp ? '　' + entry.stamp : '')).join('\n');
}
