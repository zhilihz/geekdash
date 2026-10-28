import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { failure } from './project-save.js';
import type { StatusEntry } from './project-status-entries.js';

const parse = (value: unknown): any => typeof value === 'string' ? JSON.parse(value) : value;
async function rows(c: PoolConnection, sql: string, values: unknown[] = []) { return (await c.query<RowDataPacket[]>({ sql, timeout: 10000 }, values))[0]; }
export type SourceHistoryKind = 'mixed' | 'status_description';

// 首页只消费当前可见项目的已保存说明/任务，以及各来源最近采用的说明历史。
export async function recentStatusUpdates(c:PoolConnection,projects:{id:string;name:string}[],today:string) {
  if(!projects.length)return [];
  const names=new Map(projects.map(p=>[p.id,p.name])),ids=[...names.keys()];
  const since=new Date(Date.parse(today+'T00:00:00+08:00')-29*86400000).toISOString().slice(0,19).replace('T',' ');
  const audits=await rows(c,`SELECT CAST(project_id AS CHAR) projectId,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') date,before_json beforeValues,after_json afterValues FROM audit_log WHERE project_id IN (?) AND created_at>=? AND action<>'project.import' AND (action='project.tasks.save' OR JSON_TYPE(JSON_EXTRACT(after_json,'$.statusDesc'))='STRING' AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(before_json,'$.statusDesc')),'')<>JSON_UNQUOTE(JSON_EXTRACT(after_json,'$.statusDesc'))) ORDER BY created_at DESC,id DESC LIMIT 20`,[ids,since]);
  const result:{projectId:string;name:string;date:string;text:string;kind:'online'|'source'}[]=audits.map(row=>{
    const before=parse(row.beforeValues)??{},after=parse(row.afterValues)??{};
    const text=Array.isArray(after.tasks)?after.tasks.flatMap((task:any)=>{
      const old=before.tasks?.find((t:any)=>t.id===task.id);
      if(old&&old.text===task.text&&old.completedAt===task.completedAt&&old.deletedAt===task.deletedAt)return [];
      return [(task.deletedAt?'删除任务':task.completedAt?'完成任务':old?.completedAt?'恢复任务':old?'修改任务':'新增任务')+'：'+task.text];
    }).join('\n'):after.statusDesc||'已清空状态说明';
    return {projectId:row.projectId,name:names.get(row.projectId)!,date:row.date,text,kind:'online'};
  });
  const source=await rows(c,`SELECT CAST(h.project_id AS CHAR) projectId,h.source_date_text date,h.body text FROM legacy_project_history h LEFT JOIN
    (SELECT MAX(id) id,source_namespace,target_id FROM import_adoptions WHERE target_kind='project' AND target_id IN (?) AND JSON_CONTAINS_PATH(history_manifest_json,'one','$.status_description') GROUP BY target_id,source_namespace) adopted ON adopted.id=h.source_adoption_id
    WHERE h.project_id IN (?) AND h.history_kind='status_description' AND h.source_date_text<>'' AND (adopted.id IS NOT NULL OR h.source_adoption_id IS NULL AND NOT EXISTS(SELECT 1 FROM import_adoptions a WHERE a.target_kind='project' AND a.target_id=h.project_id AND a.source_namespace=h.legacy_source_namespace AND JSON_CONTAINS_PATH(a.history_manifest_json,'one','$.status_description'))) ORDER BY h.id DESC`,[ids,ids]);
  for(const row of source)result.push({projectId:row.projectId,name:names.get(row.projectId)!,date:row.date,text:row.text,kind:'source'});
  const instant=(value:string)=>{
    const normalized=value.trim().replaceAll('/','-').replace(' ','T');
    return /^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d+)?)?)?$/.test(normalized)?Date.parse(normalized+(normalized.length===10?'T00:00:00':'')+'+08:00'):/(Z|[+-]\d\d:\d\d)$/.test(normalized)?Date.parse(normalized):NaN;
  };
  const floor=Date.parse(since.replace(' ','T')+'Z'),end=Date.parse(today+'T00:00:00+08:00')+86400000;
  return result.filter(row=>row.text&&instant(row.date)>=floor&&instant(row.date)<end).sort((a,b)=>instant(b.date)-instant(a.date)).slice(0,20);
}

export async function statusSourceBaselines(c: PoolConnection, ids: string[]) {
  const result = new Map<string, { version: string; entries: StatusEntry[] }>();
  if (!ids.length) return result;
  const found = await rows(c, `SELECT CAST(a.target_id AS CHAR) projectId,CAST(a.version_after AS CHAR) version,a.adopted_json facts FROM import_adoptions a JOIN
    (SELECT MAX(id) id FROM import_adoptions WHERE target_kind='project' AND target_id IN (${ids.map(() => '?').join(',')}) AND JSON_CONTAINS_PATH(adopted_json,'one','$.statusDescriptionBaseline') GROUP BY target_id) latest ON latest.id=a.id`, ids);
  for (const item of found) result.set(item.projectId, { version: item.version, entries: parse(item.facts).statusEntries ?? [] });
  return result;
}

// 只恢复原时间表达，不能用采用时刻补造历史；后来的线上真实时间优先。
export async function recordSourceFacts(c: PoolConnection, id: string) {
  const result = new Map<string, { version: string; values: Record<string, unknown> }>();
  const adoptions = await rows(c, "SELECT CAST(version_after AS CHAR) version,adopted_json facts FROM import_adoptions WHERE target_kind='project' AND target_id=? AND JSON_LENGTH(JSON_EXTRACT(adopted_json,'$.records'))>0 ORDER BY id DESC", [id]);
  for (const adoption of adoptions) for (const record of parse(adoption.facts).records ?? []) if (record.targetId) {
    const key = record.kind + ':' + record.targetId, prior = result.get(key);
    result.set(key, { version: prior?.version ?? adoption.version, values: { ...record.values, ...prior?.values } });
  }
  return result;
}
export function originalRecordTimes(current: Record<string, unknown>, original?: Record<string, unknown>) {
  if (!original) return;
  for (const key of ['createdAt', 'resolvedAt']) if (Object.hasOwn(original, key)) {
    const raw = original[key], value = current[key];
    const utc = typeof raw === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(raw) && !Number.isNaN(Date.parse(raw));
    if (value == null && !utc || utc && typeof value === 'string' && Date.parse(value) === Date.parse(raw as string)) current[key] = raw;
  }
}

export async function localCheckMarks(c: PoolConnection, id: string) {
  return (await rows(c, `SELECT a.source_namespace sourceNamespace,s.name sourceName,a.adopted_json facts FROM import_adoptions a JOIN
    (SELECT MAX(id) id FROM import_adoptions WHERE target_kind='project' AND target_id=? AND JSON_CONTAINS_PATH(adopted_json,'one','$.lastCheckAt') GROUP BY source_namespace) latest ON latest.id=a.id
    JOIN import_sources s ON s.source_namespace=a.source_namespace ORDER BY a.id`, [id])).map(row => ({ sourceNamespace: row.sourceNamespace, sourceName: row.sourceName, value: parse(row.facts).lastCheckAt }));
}

export async function sourceHistory(c: PoolConnection, projectId: string, kind: SourceHistoryKind, sourceNamespace?: string, adoptionId?: string, before?: string) {
  const project = (await rows(c, 'SELECT CAST(version AS CHAR) version FROM projects WHERE id=?', [projectId]))[0];
  if (!project) failure('PROJECT_NOT_FOUND', 404);
  const versions = await rows(c, `SELECT CAST(a.id AS CHAR) id,a.source_namespace sourceNamespace,s.name sourceName,CAST(a.item_id AS CHAR) itemId,
    DATE_FORMAT(a.created_at,'%Y-%m-%dT%H:%i:%s.%fZ') adoptedAt,a.history_manifest_json manifest FROM import_adoptions a JOIN import_sources s ON s.source_namespace=a.source_namespace
    WHERE a.target_kind='project' AND a.target_id=? AND JSON_CONTAINS_PATH(a.history_manifest_json,'one',?)${sourceNamespace ? ' AND a.source_namespace=?' : ''}${before ? ' AND a.id<?' : ''} ORDER BY a.id DESC LIMIT 51`,
    [projectId, '$.' + kind, ...sourceNamespace ? [sourceNamespace] : [], ...before ? [before] : []]);
  const page = versions.slice(0, 50).map(row => ({ id: String(row.id), sourceNamespace: String(row.sourceNamespace), sourceName: String(row.sourceName), itemId: String(row.itemId), adoptedAt: String(row.adoptedAt), count: Number(parse(row.manifest)[kind].count) }));
  const latest = await rows(c, `SELECT CAST(a.id AS CHAR) id,a.source_namespace sourceNamespace,s.name sourceName,CAST(a.item_id AS CHAR) itemId FROM import_adoptions a JOIN
    (SELECT MAX(id) id FROM import_adoptions WHERE target_kind='project' AND target_id=? AND JSON_CONTAINS_PATH(history_manifest_json,'one',?)${sourceNamespace ? ' AND source_namespace=?' : ''} GROUP BY source_namespace) latest ON latest.id=a.id
    JOIN import_sources s ON s.source_namespace=a.source_namespace ORDER BY a.id`, [projectId, '$.' + kind, ...sourceNamespace ? [sourceNamespace] : []]);
  let selected = latest;
  if (adoptionId && adoptionId !== 'legacy') {
    selected = await rows(c, `SELECT CAST(a.id AS CHAR) id,a.source_namespace sourceNamespace,s.name sourceName,CAST(a.item_id AS CHAR) itemId FROM import_adoptions a JOIN import_sources s ON s.source_namespace=a.source_namespace WHERE a.id=? AND a.target_kind='project' AND a.target_id=? AND JSON_CONTAINS_PATH(a.history_manifest_json,'one',?)${sourceNamespace ? ' AND a.source_namespace=?' : ''}`, [adoptionId, projectId, '$.' + kind, ...sourceNamespace ? [sourceNamespace] : []]);
    if (!selected.length) failure('IMPORT_HISTORY_NOT_FOUND', 404);
  }
  if (adoptionId === 'legacy') selected = [];
  const sources = [];
  for (const version of selected) sources.push({ ...version, entries: await rows(c, 'SELECT CAST(id AS CHAR) id,source_date_text date,body text FROM legacy_project_history WHERE source_adoption_id=? AND history_kind=? ORDER BY source_sequence,id', [version.id, kind]) });
  const nextCursor = versions.length > 50 ? String(page.at(-1)!.id) : null;
  const legacy = await rows(c, `SELECT CAST(h.id AS CHAR) id,h.legacy_source_namespace sourceNamespace,s.name sourceName,h.source_date_text date,h.body text FROM legacy_project_history h LEFT JOIN import_sources s ON s.source_namespace=h.legacy_source_namespace WHERE h.project_id=? AND h.history_kind=? AND h.source_adoption_id IS NULL${sourceNamespace ? ' AND h.legacy_source_namespace=?' : ''} ORDER BY h.source_sequence,h.id`, [projectId, kind, ...sourceNamespace ? [sourceNamespace] : []]);
  if (!adoptionId || adoptionId === 'legacy') for (const namespace of new Set(legacy.map(row => row.sourceNamespace as string | null))) if (adoptionId === 'legacy' || !latest.some(row => row.sourceNamespace === namespace)) sources.push({ id: null, sourceNamespace: namespace, sourceName: legacy.find(row => row.sourceNamespace === namespace)?.sourceName ?? '原本地来源', itemId: null, entries: legacy.filter(row => row.sourceNamespace === namespace) });
  if (legacy.length && !before) page.push({ id: 'legacy', sourceNamespace: sourceNamespace ?? '', sourceName: '最初本地来源记录', itemId: '', adoptedAt: '', count: legacy.length });
  return { kind, projectVersion: project.version as string, sources, versions: page, nextCursor };
}
