export type Project = {
  id: string; version: string; name: string; status: string; priority: string; signal: string;
  customer: string | null; odmFactory: string | null; productLine: string | null; app: string | null; projectGroup: string | null;
  proposalDate: string | null; dueDate: string | null; marketExpectation: string; statusDesc: string;
  manualDelayed: number; maintenanceEnabled: number; updatedAt: string; stage: string; progress: string | number;
  chips: { id: string; name: string }[]; people: { id: string; name: string; role: string }[]; tags: { id: string; name: string }[];
};
export type List = { items: Project[]; stats: Record<string, number>; options: Record<string, string[]>; stageCounts: { value: string; count: string | number }[]; pagination: { page: number; pageSize: number; total: number; pageCount: number }; readOnly: true };
export type Entry = Record<string, string | number | null>;
export type Detail = { project: Project & Record<string, unknown>; stages: Entry[]; nodes: Entry[]; risks: Entry[]; changes: Entry[]; delays: Entry[]; history: Entry[]; readOnly: true };
export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(response.status === 404 ? '未找到该项目，请返回列表重新选择。' : response.status === 400 ? '查询条件无效，请重新选择。' : '服务器暂时无法读取数据，请重试。');
  return response.json();
}
export function esc(value: unknown) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
export const labels: Record<string, string> = { proposal: '提案中', ongoing: '进行中', paused: '暂缓', closed: '已结案', high: '高', mid: '中', low: '低', green: '绿灯', yellow: '黄灯', red: '红灯', locked: '未解锁', ready: '待开始', active: '进行中', completed: '已完成', unconfigured: '阶段未配置', S1: '需求立项', S2: '项目预启动', S3: 'PEVT技术预研', S4: 'EVT集成验证', S5: 'DVT可靠性验证', S6: 'PVT量产验证', S7: 'MP量产维护', hardware_owner: '硬件负责人', software_owner: '软件负责人', pm: '项目经理', participant: '参与人', normal: '正常结案', terminated: '终止结案' };
export function label(value: unknown) { return value === 'accept' ? '接受' : value === 'reject' ? '拒绝' : Object.hasOwn(labels, String(value)) ? labels[String(value)] : String(value ?? '—'); }
export function projectTags(project: Project) {
  const statuses: Record<string, string> = { ongoing: 'active', proposal: 'proposal', paused: 'hold', closed: 'closed' };
  return `<span class="signal-tag signal-${esc(project.signal)}"><span class="signal-dot"></span>${label(project.signal)}</span><span class="pri-tag pri-${esc(project.priority)}">${label(project.priority)}优先级</span><span class="st-tag st-${statuses[project.status]}">${label(project.status)}</span>${project.status === 'closed' && project.maintenanceEnabled ? '<span class="maintenance-badge">量产维护</span>' : ''}`;
}
export function setupTheme() {
  let theme = 'dark';
  try { theme = localStorage.getItem('geekdash_theme') ?? 'dark'; } catch { /* 浏览偏好不可用不阻止读取。 */ }
  function apply(value: string) {
    document.documentElement.dataset.theme = ['dark', 'light', 'warm'].includes(value) ? value : 'dark';
    document.querySelectorAll<HTMLButtonElement>('button[data-theme]').forEach(button => button.classList.toggle('active', button.dataset.theme === document.documentElement.dataset.theme));
  }
  apply(theme);
  document.querySelectorAll<HTMLButtonElement>('button[data-theme]').forEach(button => button.onclick = () => {
    apply(button.dataset.theme!);
    try { localStorage.setItem('geekdash_theme', button.dataset.theme!); } catch { /* 本机显示偏好。 */ }
  });
}
