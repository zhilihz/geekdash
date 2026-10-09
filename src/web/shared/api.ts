export type Project = {
  id: string; version: string; dataKind: 'business' | 'trial'; name: string; status: string; priority: string; signal: string;
  customer: string | null; odmFactory: string | null; productLine: string | null; app: string | null; projectGroup: string | null;
  proposalDate: string | null; dueDate: string | null; marketExpectation: string; statusDesc: string;
  manualDelayed: number; maintenanceEnabled: number; updatedAt: string; stage: string; progress: string | number;
  chips: { id: string; name: string }[]; people: { id: string; name: string; role: string }[]; tags: { id: string; name: string }[];
};
export type List = { items: Project[]; stats: Record<string, number>; options: Record<string, string[]>; stageCounts: { value: string; count: string | number }[]; pagination: { page: number; pageSize: number; total: number; pageCount: number }; readOnly: true };
export type Entry = Record<string, string | number | null>;
export type TextValues = { name: string; marketExpectation: string; detailNote: string; summaryNote: string };
export type SaveRequest = { expectedVersion: string; idempotencyKey: string; changes: Partial<TextValues> };
export type SaveResult = { projectId: string; operationId: string; changed: boolean; savedVersion: string; values: TextValues; savedAt: string | null };
export type Audit = { id: string; actorDisplayName: string; actorKind: string; versionBefore: string; versionAfter: string; createdAt: string; beforeValues: Partial<TextValues>; afterValues: Partial<TextValues> };
export type AuditPage = { items: Audit[]; nextCursor: string | null; pageSize: number };
export type Detail = { project: Project & TextValues & Record<string, unknown>; stages: Entry[]; nodes: Entry[]; risks: Entry[]; changes: Entry[]; delays: Entry[]; history: Entry[]; readOnly: boolean; capabilities: { editText: boolean } };
export class SaveError extends Error {
  constructor(public code: string, public outcome: string, public fields?: Record<string, string>) {
    super(({ PROJECT_VERSION_CONFLICT: '项目已被他人更新，请重新进入项目。', OPERATION_KEY_REUSED: '操作编号与原请求不一致，请保留文字并核对原操作。', PROJECT_READ_ONLY: '此项目只能查看。', INVALID_PROJECT_FIELDS: '请修正标出的字段。', DATABASE_UNAVAILABLE: '数据库暂时不可用，请重试。', SAVE_ROLLED_BACK: '保存未完成，修改已保留。' } as Record<string, string>)[code] ?? '保存结果尚未确认，请确认结果或重试原操作。');
  }
}
export async function send<T>(path: string, method: 'PATCH' | 'POST', body: SaveRequest): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(10000) }); }
  catch { throw new SaveError('TRANSPORT_UNKNOWN', 'unknown'); }
  let data;
  try { data = await response.json(); } catch { throw new SaveError('RESPONSE_UNKNOWN', 'unknown'); }
  if (!response.ok) throw new SaveError(data.code, data.outcome ?? 'unknown', data.fields);
  return data as T;
}
export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }); }
  catch { throw new Error('读取超时或网络暂时不可用，请重试。'); }
  if (!response.ok) throw new Error(response.status === 404 ? '未找到该项目，请返回列表重新选择。' : response.status === 400 ? '查询条件无效，请重新选择。' : '服务器暂时无法读取数据，请重试。');
  try { return await response.json(); } catch { throw new Error('服务器响应未能读取，请重试。'); }
}
export function esc(value: unknown) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
export const labels: Record<string, string> = { proposal: '提案中', ongoing: '进行中', paused: '暂缓', closed: '已结案', high: '高', mid: '中', low: '低', green: '绿灯', yellow: '黄灯', red: '红灯', locked: '未解锁', ready: '待开始', active: '进行中', completed: '已完成', unconfigured: '阶段未配置', S1: '需求立项', S2: '项目预启动', S3: 'PEVT技术预研', S4: 'EVT集成验证', S5: 'DVT可靠性验证', S6: 'PVT量产验证', S7: 'MP量产维护', hardware_owner: '硬件负责人', software_owner: '软件负责人', pm: '项目经理', participant: '参与人', normal: '正常结案', terminated: '终止结案' };
export function label(value: unknown) { return value === 'accept' ? '接受' : value === 'reject' ? '拒绝' : Object.hasOwn(labels, String(value)) ? labels[String(value)] : String(value ?? '—'); }
export function projectTags(project: Project) {
  const statuses: Record<string, string> = { ongoing: 'active', proposal: 'proposal', paused: 'hold', closed: 'closed' };
  return `<span class="signal-tag signal-${esc(project.signal)}"><span class="signal-dot"></span>${label(project.signal)}</span><span class="pri-tag pri-${esc(project.priority)}">${label(project.priority)}优先级</span><span class="st-tag st-${statuses[project.status]}">${label(project.status)}</span>${project.dataKind === 'trial' ? '<span class="maintenance-badge">测试项目</span>' : ''}${project.status === 'closed' && project.maintenanceEnabled ? '<span class="maintenance-badge">量产维护</span>' : ''}`;
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
