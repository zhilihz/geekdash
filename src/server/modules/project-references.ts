import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

// 五类关联各有真实外键；同一份定义用于写入、读取、筛选和资料引用检查。
export const projectReferences = {
  customerIds: { table: 'project_customers', reference: 'customer_id', catalog: 'customers', legacy: 'customerId', column: 'customer_id', dimension: 'customer' },
  odmFactoryIds: { table: 'project_odm_factories', reference: 'customer_id', catalog: 'customers', legacy: 'odmCustomerId', column: 'odm_customer_id', dimension: 'odmFactory' },
  productLineIds: { table: 'project_product_lines', reference: 'product_line_id', catalog: 'product_lines', legacy: 'productLineId', column: 'product_line_id', dimension: 'productLine' },
  appIds: { table: 'project_apps', reference: 'app_id', catalog: 'apps', legacy: 'appId', column: 'app_id', dimension: 'app' },
  groupIds: { table: 'project_group_links', reference: 'group_id', catalog: 'project_groups', legacy: 'groupId', column: 'group_id', dimension: 'group' },
} as const;
export type ReferenceField = keyof typeof projectReferences;
export type ChipSelection = { selectionId: string; chipId: string; note: string };
export type ProjectReferences = Partial<Record<ReferenceField, string[]>> & { chipSelections?: ChipSelection[] };

export async function readProjectReferences(c: PoolConnection, projectId: string): Promise<ProjectReferences> {
  const result: ProjectReferences = {};
  for (const [key, link] of Object.entries(projectReferences)) {
    const [rows] = await c.query<RowDataPacket[]>(`SELECT CAST(${link.reference} AS CHAR) id FROM ${link.table} WHERE project_id=? ORDER BY sort_order,${link.reference}`, [projectId]);
    result[key as ReferenceField] = rows.map(row => row.id);
  }
  const [chips] = await c.query<RowDataPacket[]>('SELECT selection_id selectionId,CAST(chip_id AS CHAR) chipId,note FROM project_chip_selections WHERE project_id=? ORDER BY sort_order,selection_id', [projectId]);
  result.chipSelections = chips.map(({ selectionId, chipId, note }) => ({ selectionId, chipId, note }));
  return result;
}

export async function writeProjectReferences(c: PoolConnection, projectId: string, changes: ProjectReferences) {
  for (const [key, link] of Object.entries(projectReferences)) {
    const values = changes[key as ReferenceField];
    if (values === undefined) continue;
    await c.execute(`DELETE FROM ${link.table} WHERE project_id=?`, [projectId]);
    for (const [index, id] of values.entries()) await c.execute(`INSERT INTO ${link.table}(project_id,${link.reference},sort_order) VALUES (?,?,?)`, [projectId, id, index]);
  }
  if (changes.chipSelections !== undefined) {
    await c.execute('DELETE FROM project_chip_selections WHERE project_id=?', [projectId]);
    for (const [index, item] of changes.chipSelections.entries()) await c.execute('INSERT INTO project_chip_selections(project_id,selection_id,chip_id,note,sort_order) VALUES (?,?,?,?,?)', [projectId, item.selectionId, item.chipId, item.note, index]);
  }
}

// 旧备份/草稿的单值仅在输入边界展开；从来不把多值名单压回旧字段。
export function expandLegacyReferences<T extends Record<string, unknown>>(input: T): T & ProjectReferences {
  const result: Record<string, unknown> = { ...input };
  for (const [key, link] of Object.entries(projectReferences)) {
    if (Object.hasOwn(result, link.legacy)) {
      if (!Object.hasOwn(result, key)) result[key] = result[link.legacy] === null ? [] : [result[link.legacy]];
      delete result[link.legacy];
    }
  }
  if (Object.hasOwn(result, 'chipIds')) {
    if (!Object.hasOwn(result, 'chipSelections')) result.chipSelections = (result.chipIds as string[]).map(id => ({ selectionId: 'legacy:' + id, chipId: id, note: '' }));
    delete result.chipIds;
  }
  return result as T & ProjectReferences;
}
