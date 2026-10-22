export const importCatalogKinds = ['customers', 'engineers', 'productLines', 'apps', 'tags', 'groups', 'chips', 'company'] as const;
export type ImportCatalogKind = typeof importCatalogKinds[number];
export type ImportSourceKind = 'project' | ImportCatalogKind;
export type ImportSourceIssue = { code: string; path: string; message: string; severity: 'warning' | 'error' };
export type ImportSourceItem = {
  kind: ImportSourceKind; sequence: number; sourceKey: string | null;
  raw: Record<string, unknown>; present: string[]; issues: ImportSourceIssue[];
  originPaths?: string[];
};
export type ParsedImportSource = {
  format: 'json' | 'base64-json'; version: number | null; appVersion: string | null; exportedAt: unknown;
  items: ImportSourceItem[]; preferences: Record<string, unknown>; raw: Record<string, unknown>; issues: ImportSourceIssue[];
};

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const issue = (code: string, path: string, message: string, severity: 'warning' | 'error' = 'warning'): ImportSourceIssue => ({ code, path, message, severity });
function reject(code: string, message: string): never { throw Object.assign(new Error(message), { code, status: 422 }); }

function json(text: string): unknown {
  // Node 24 exposes the source token: do not round an old numeric identifier before mapping it.
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) && context?.source ? context.source : value);
}

export function importSourceKey(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== 'string' || value.length > 128 || !/^\d+$/.test(value) || !/[1-9]/.test(value)) return null;
  return value.replace(/^0+/, '');
}

function decode(input: Uint8Array | string): { format: ParsedImportSource['format']; value: unknown } {
  let text: string;
  try { text = (typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input)).replace(/^\uFEFF/, '').trim(); }
  catch { reject('IMPORT_ENCODING_INVALID', '备份不是有效的 UTF-8 文件。'); }
  try { return { format: 'json', value: json(text) }; } catch { /* Older .bak files wrap the JSON in base64. */ }
  const compact = text.replace(/\s/g, '');
  if (compact && /^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length % 4 === 0) {
    const bytes = Buffer.from(compact, 'base64');
    if (bytes.toString('base64') === compact) {
      try { return { format: 'base64-json', value: json(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')) }; } catch { /* Report the container failure without exposing file contents. */ }
    }
  }
  reject('IMPORT_FORMAT_INVALID', '无法读取备份：需要 GeekDash JSON 或 base64 JSON 备份。');
}

export function parseImportSource(input: Uint8Array | string): ParsedImportSource {
  const { format, value } = decode(input);
  if (!object(value) || !Array.isArray(value.projects)) reject('IMPORT_FORMAT_INVALID', '备份根节点必须包含 projects 数组。');
  const version = Object.hasOwn(value, 'version') ? value.version : null;
  if (version !== null && version !== 1 && version !== 2) reject('IMPORT_VERSION_UNSUPPORTED', '当前支持备份结构版本 1、2；请保留文件并核对其版本。');
  const items: ImportSourceItem[] = [], issues: ImportSourceIssue[] = [];
  const preferences = object(value.preferences) ? structuredClone(value.preferences) : {};
  if (Object.hasOwn(value, 'preferences') && !object(value.preferences)) issues.push(issue('IMPORT_PREFERENCES_INVALID', 'preferences', '偏好设置无法识别，原内容保留；不会写入个人设置。'));
  const append = (kind: ImportSourceKind, entries: unknown[], path: string) => {
    const keys = entries.map(entry => object(entry) ? importSourceKey(entry.id) : null);
    const counts = new Map<string, number>();
    for (const key of keys) if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
    entries.forEach((entry, index) => {
      const entryIssues: ImportSourceIssue[] = [], entryPath = kind === 'company' ? path : `${path}[${index}]`;
      // Invalid entries remain visible and recoverable instead of being filtered out.
      const raw: Record<string, unknown> = object(entry) ? structuredClone(entry) : { $invalidSource: entry };
      if (!object(entry)) entryIssues.push(issue('IMPORT_ITEM_INVALID', entryPath, '该条目不是对象，请在原卡纠正后采用。', 'error'));
      let sourceKey = kind === 'company' ? null : keys[index];
      if (kind !== 'company' && sourceKey === null) entryIssues.push(issue('IMPORT_SOURCE_KEY_MISSING', `${entryPath}.id`, '来源编号缺失或无效，本条需要明确对应，不建立永久来源绑定。'));
      if (sourceKey !== null && counts.get(sourceKey)! > 1) {
        sourceKey = null;
        entryIssues.push(issue('IMPORT_SOURCE_KEY_DUPLICATE', `${entryPath}.id`, '同类来源编号重复，保留每条内容并分别确认对应。'));
      }
      items.push({ kind, sequence: index + 1, sourceKey, raw, present: Object.keys(raw), issues: entryIssues });
    });
  };
  append('project', value.projects, 'projects');
  for (const kind of importCatalogKinds) {
    if (!Object.hasOwn(value, kind)) continue;
    if (kind === 'company') append(kind, [value[kind]], kind);
    else if (Array.isArray(value[kind])) append(kind, value[kind], kind);
    else {
      append(kind, [value[kind]], kind);
      items.at(-1)!.issues.push(issue('IMPORT_COLLECTION_INVALID', kind, '资料集合必须是数组，原内容保留供纠正。', 'error'));
    }
  }
  for (const [key, field] of [['hw_project_board_summary_notes', 'summary_note'], ['hw_project_board_chipstat_notes', 'chipstat_note']] as const) {
    if (!Object.hasOwn(preferences, key)) continue;
    let notes: unknown = preferences[key];
    if (typeof notes === 'string') { try { notes = json(notes); } catch { notes = null; } }
    if (!object(notes)) { issues.push(issue('IMPORT_NOTES_INVALID', `preferences.${key}`, '项目备注容器无法识别，原内容保留；不按空备注覆盖。')); continue; }
    for (const item of items) if (item.kind === 'project' && item.sourceKey) {
      const noteKeys = [...new Set([String(item.raw.id), item.sourceKey])].filter(key => Object.hasOwn(notes, key));
      if (!noteKeys.length) continue;
      const note = notes[noteKeys[0]];
      if (noteKeys.some(key => notes[key] !== note) || Object.hasOwn(item.raw, field) && item.raw[field] !== note) {
        item.issues.push(issue('IMPORT_NOTES_AMBIGUOUS', `preferences.${key}.${item.sourceKey}`, '项目内备注与页面备注不同，请在原卡明确采用内容。', 'error'));
      } else { item.raw[field] = note; item.present = Object.keys(item.raw); }
    }
  }
  const named = new Map<string, ImportSourceItem[]>(), sequences = new Map<ImportSourceKind, number>(), derived = new Set<ImportSourceItem>();
  for (const item of items) sequences.set(item.kind, item.sequence);
  for (const item of items) if (item.kind !== 'project' && item.kind !== 'company' && typeof item.raw.name === 'string') {
    const key = JSON.stringify([item.kind, item.raw.name]);
    named.set(key, [...named.get(key) ?? [], item]);
  }
  const reference = (kind: ImportCatalogKind, name: unknown, path: string) => {
    if (typeof name !== 'string' || !name.trim()) return;
    const key = JSON.stringify([kind, name]), candidates = named.get(key);
    if (candidates) { for (const candidate of candidates) (candidate.originPaths ??= []).push(path); return; }
    const sequence = (sequences.get(kind) ?? 0) + 1; sequences.set(kind, sequence);
    const item: ImportSourceItem = { kind, sequence, sourceKey: null,
      raw: { name, $sourceNameOnly: true, $sourceReferences: [path] }, present: ['name'], originPaths: [path], issues: [] };
    items.push(item); named.set(key, [item]); derived.add(item);
  };
  const references: [string, ImportCatalogKind][] = [['customer', 'customers'], ['odmFactory', 'customers'], ['productLine', 'productLines'],
    ['app', 'apps'], ['group', 'groups'], ['pm', 'engineers'], ['hwOwner', 'engineers'], ['swOwner', 'engineers'],
    ['participants', 'engineers'], ['chips', 'chips'], ['tags', 'tags']];
  for (const item of items.filter(row => row.kind === 'project')) for (const [field, kind] of references) {
    const value = item.raw[field];
    for (const [index, name] of (Array.isArray(value) ? value : [value]).entries()) reference(kind, name, `projects[${item.sequence - 1}].${field}${Array.isArray(value) ? `[${index}]` : ''}`);
  }
  for (const item of items.filter(row => row.kind === 'customers')) if (Array.isArray(item.raw.tags)) {
    item.raw.tags.forEach((name, index) => reference('tags', name, `customers[${item.sequence - 1}].tags[${index}]`));
  }
  for (const item of derived) item.raw.$sourceReferences = [...item.originPaths!];
  return { format, version, appVersion: typeof value.appVersion === 'string' ? value.appVersion : null,
    exportedAt: value.exportedAt ?? null, items, preferences, raw: value, issues };
}
