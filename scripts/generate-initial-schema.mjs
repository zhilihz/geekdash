// 仅生成未应用的首版资源；发布后修改结构需新增迁移。
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const erd = await readFile(new URL('../docs/data/ERD.md', import.meta.url), 'utf8');
const types = { I: 'bigint unsigned', R: 'bigint unsigned', N: 'int unsigned', S: 'smallint unsigned', D: 'date', T: 'datetime(3)', X: 'text', J: 'json', H: 'binary(32)', U: 'char(36)', DEC: 'decimal(12,3)', B: 'tinyint' };
const ascii = new Set(['login_name', 'status', 'priority', 'signal', 'resume_status', 'pre_close_status', 'closure_type', 'stage_code', 'state', 'kind', 'decision', 'level', 'conclusion', 'actor_kind', 'action', 'entity_type', 'request_id', 'device_key', 'scope', 'form_kind', 'format', 'item_kind', 'type', 'command_scope', 'idempotency_key']);
const enums = {
  'projects.status': ['proposal', 'ongoing', 'paused', 'closed'],
  'projects.resume_status': ['proposal', 'ongoing', 'paused', 'closed'],
  'projects.pre_close_status': ['proposal', 'ongoing', 'paused', 'closed'],
  'projects.priority': ['high', 'mid', 'low'], 'projects.signal': ['green', 'yellow', 'red'],
  'projects.closure_type': ['normal', 'terminated'],
  'project_stages.stage_code': ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'],
  'project_stages.state': ['locked', 'ready', 'active', 'completed'],
  'project_nodes.kind': ['project', 'customer'],
  'project_risks.level': ['high', 'mid', 'low'], 'project_changes.decision': ['accept', 'reject'],
  'schedule_changes.kind': ['reschedule', 'note'], 'project_checks.conclusion': ['checked', 'follow_up'],
  'audit_log.actor_kind': ['user', 'system'], 'project_drafts.state': ['active', 'committed', 'discarded'],
  'meetings.state': ['running', 'paused', 'finished'], 'import_items.status': ['pending', 'committed'],
  'feedback_entries.type': ['bug', 'suggestion'],
};
const tables = [];
for (const match of erd.matchAll(/^\| ([a-z_]+) \| (.+?) \| (.+?) \|/gm)) {
  const [, name, fields, rules] = match;
  if (!fields.includes('`') || !rules.includes('PK(')) continue;
  const columns = [...fields.matchAll(/`([a-z_]+):([A-Z]+\d*)(\?)?`/g)].map(([, column, code, optional]) => {
    const type = /^V\d+$/.test(code) ? `varchar(${code.slice(1)})` : types[code];
    assert.ok(type, `${name}.${column} 未知类型`);
    const string = /^(?:varchar|char|text)/.test(type);
    const charset = string ? (code === 'U' || name === 'schema_migrations' || ascii.has(column) ? 'ascii' : 'utf8mb4') : null;
    const collation = string ? (charset === 'ascii' ? 'ascii_bin' : ['source_namespace', 'source_key'].includes(column) ? 'utf8mb4_0900_bin' : 'utf8mb4_0900_ai_ci') : null;
    const autoIncrement = code === 'I' && (column === 'id' && name !== 'system_configuration' || name === 'check_rule_revisions' && column === 'version');
    let defaultValue = null;
    if (code === 'R' || code === 'B' && ['enabled', 'must_change_password'].includes(column)) defaultValue = '1';
    if (code === 'B' && ['manual_delayed', 'maintenance_enabled'].includes(column)) defaultValue = '0';
    if (name === 'projects' && column === 'status') defaultValue = 'proposal';
    if (name === 'projects' && column === 'priority') defaultValue = 'mid';
    if (name === 'projects' && column === 'signal') defaultValue = 'green';
    return { name: column, type, nullable: !!optional, default: defaultValue, autoIncrement, charset, collation };
  });
  const indexes = [...rules.matchAll(/(PK|UK|IDX)\(([^)]+)\)/g)].map(([, kind, fields]) => {
    const cols = fields.split(',');
    return { name: kind === 'PK' ? 'PRIMARY' : `${kind.toLowerCase()}_${cols.join('_')}`, unique: kind !== 'IDX', columns: cols };
  });
  const checks = [];
  for (const column of columns) {
    const code = [...fields.matchAll(/`([a-z_]+):([A-Z]+\d*)(\?)?`/g)].find(m => m[1] === column.name)[2];
    const values = enums[`${name}.${column.name}`];
    if (code === 'B') checks.push({ name: `ck_${name}_${column.name}`, expression: `\`${column.name}\` IN (0,1)` });
    if (values) checks.push({ name: `ck_${name}_${column.name}`, expression: `\`${column.name}\` IN (${values.map(v => `'${v}'`).join(',')})` });
  }
  if (name === 'system_configuration') checks.push({ name: 'ck_system_configuration_singleton', expression: '`id` = 1' });
  if (name === 'check_rule_revisions') checks.push({ name: 'ck_check_rule_revisions_weekday', expression: '`deadline_weekday` BETWEEN 1 AND 7' });
  if (name === 'users') checks.push({ name: 'ck_users_login_lowercase', expression: '`login_name` = LOWER(`login_name`)' });
  tables.push({ name, columns, indexes, checks, foreignKeys: [] });
}
assert.equal(tables.length, 34);
assert.equal(tables.reduce((n, table) => n + table.columns.length, 0), 313);
const graph = [...erd.matchAll(/```mermaid\s+erDiagram([\s\S]*?)```/g)].find(match => match[1].includes('SCHEMA_MIGRATIONS {'))[1];
for (const [, parentRaw, childRaw, label] of graph.matchAll(/^\s+([A-Z_]+) [o|{}-]+ ([A-Z_]+) : ([a-z_]+)$/gm)) {
  const parent = parentRaw.toLowerCase();
  const table = tables.find(t => t.name === childRaw.toLowerCase());
  const column = table.columns.some(c => c.name === label) ? label : `${label}_id`;
  assert.ok(table.columns.some(c => c.name === column), `${table.name}.${column} 外键缺列`);
  const composite = table.name === 'project_nodes' && ['stage_id', 'previous_node_id', 'next_node_id'].includes(column);
  const columns = composite ? ['project_id', column] : [column];
  const references = composite ? ['project_id', 'id'] : [parent === 'check_rule_revisions' ? 'version' : 'id'];
  const name = `fk_${table.name}_${column}`;
  table.foreignKeys.push({ name, columns, parent, references, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' });
  if (!table.indexes.some(index => columns.every((c, i) => index.columns[i] === c))) {
    table.indexes.push({ name: `idx_fk_${column}`, unique: false, columns });
  }
}
assert.equal(tables.reduce((n, table) => n + table.foreignKeys.length, 0), 55);
const quoteColumns = cols => cols.map(c => `\`${c}\``).join(', ');
for (const table of tables) {
  const definitions = table.columns.map(c => {
    const defaults = c.default === null ? '' : ` DEFAULT ${/^\d+$/.test(c.default) ? c.default : `'${c.default}'`}`;
    return `\`${c.name}\` ${c.type}${c.charset ? ` CHARACTER SET ${c.charset} COLLATE ${c.collation}` : ''}${c.nullable ? ' NULL' : ' NOT NULL'}${defaults}${c.autoIncrement ? ' AUTO_INCREMENT' : ''}`;
  });
  for (const index of table.indexes) definitions.push(`${index.name === 'PRIMARY' ? 'PRIMARY KEY' : `${index.unique ? 'UNIQUE ' : ''}KEY \`${index.name}\``} (${quoteColumns(index.columns)})`);
  for (const check of table.checks) definitions.push(`CONSTRAINT \`${check.name}\` CHECK (${check.expression})`);
  table.sql = `CREATE TABLE \`${table.name}\` (\n  ${definitions.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`;
  for (const fk of table.foreignKeys) fk.sql = `ALTER TABLE \`${table.name}\` ADD CONSTRAINT \`${fk.name}\` FOREIGN KEY (${quoteColumns(fk.columns)}) REFERENCES \`${fk.parent}\` (${quoteColumns(fk.references)}) ON UPDATE RESTRICT ON DELETE RESTRICT`;
}
tables.sort((a, b) => a.name === 'schema_migrations' ? -1 : b.name === 'schema_migrations' ? 1 : a.name.localeCompare(b.name));
await mkdir(new URL('../migrations/', import.meta.url), { recursive: true });
await writeFile(new URL('../migrations/0001-foundation.json', import.meta.url), JSON.stringify({ version: '0001-foundation', tables }, null, 2) + '\n', { flag: 'wx' });
console.log('首版资源已生成：34 表、313 列、55 外键；尚未执行。');
