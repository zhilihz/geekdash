import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { connectDatabase, type DatabaseProfile } from './db.js';

type Column = { name: string; type: string; nullable: boolean; default: string | null; autoIncrement: boolean; charset: string | null; collation: string | null };
type Index = { name: string; unique: boolean; columns: string[] };
type Check = { name: string; expression: string };
type ForeignKey = { name: string; columns: string[]; parent: string; references: string[]; onUpdate: string; onDelete: string; sql: string };
type Table = { name: string; columns: Column[]; indexes: Index[]; checks: Check[]; foreignKeys: ForeignKey[]; sql: string };
type Manifest = { version: string; tables: Table[] };
type DataStep = 'seed-import-sources' | 'freeze-legacy-history-source';
type MigrationStep = { table: string; sql?: string; create?: Table; columns?: Column[]; indexes?: Index[]; checks?: Check[]; foreignKeys?: ForeignKey[]; dropIndexes?: string[]; data?: DataStep };
type ResolvedStep = MigrationStep & { before: Table | undefined; after: Table };
type ActualTable = { name: string; engine: string; collation: string; columns: Column[]; indexes: Index[]; checks: Check[]; foreignKeys: Omit<ForeignKey, 'sql'>[] };
type Difference = { table: string; object: string; expected: unknown; actual: unknown };

function fail(code: string, differences: Difference[] = []): never {
  throw Object.assign(new Error(code), { code, differences });
}

export async function loadSchema() {
  const bytes = await readFile(new URL('../../migrations/0001-foundation.json', import.meta.url));
  const foundation = JSON.parse(bytes.toString('utf8')) as Manifest;
  if (foundation.version !== '0001-foundation' || foundation.tables.length !== 34) fail('DB_MIGRATION_RESOURCE_INVALID');
  let manifest = structuredClone(foundation);
  const history = [{ version: foundation.version, checksum: createHash('sha256').update(bytes).digest() }];
  const increments: { previous: Manifest; manifest: Manifest; steps: ResolvedStep[] }[] = [];
  for (const [version, count] of [['0002-trial-save', 3], ['0003-node-recovery', 1], ['0004-project-compatibility', 2], ['0005-check-facts', 1], ['0006-imports', 11]] as const) {
    const bytes = await readFile(new URL('../../migrations/' + version + '.json', import.meta.url));
    const delta = JSON.parse(bytes.toString('utf8')) as { version: string; steps: MigrationStep[] };
    if (delta.version !== version || delta.steps.length !== count) fail('DB_MIGRATION_RESOURCE_INVALID');
    const previous = manifest; manifest = structuredClone(previous); manifest.version = version;
    const steps: ResolvedStep[] = [];
    for (const step of delta.steps) {
      let table = manifest.tables.find(table => table.name === step.table);
      const before = table && structuredClone(table);
      if (step.create) {
        if (table || step.create.name !== step.table || !step.sql || step.data) fail('DB_MIGRATION_RESOURCE_INVALID');
        table = structuredClone(step.create); manifest.tables.push(table);
      }
      if (!table) fail('DB_MIGRATION_RESOURCE_INVALID');
      if (step.data && (!['seed-import-sources', 'freeze-legacy-history-source'].includes(step.data) || step.sql || step.create)
        || !step.data && !step.sql) fail('DB_MIGRATION_RESOURCE_INVALID');
      for (const name of step.dropIndexes ?? []) {
        if (!table.indexes.some(index => index.name === name)) fail('DB_MIGRATION_RESOURCE_INVALID');
        table.indexes = table.indexes.filter(index => index.name !== name);
      }
      for (const kind of ['columns', 'indexes', 'checks', 'foreignKeys'] as const) for (const item of step[kind] ?? []) {
        const items = table[kind] as { name: string }[];
        const index = items.findIndex(existing => existing.name === item.name);
        if (index === -1) items.push(item); else items[index] = item;
      }
      steps.push({ ...step, before, after: structuredClone(table) });
    }
    increments.push({ previous, manifest, steps });
    history.push({ version, checksum: createHash('sha256').update(bytes).digest() });
  }
  return { manifest, foundation, increments, history, checksum: history.at(-1)!.checksum };
}

async function query(connection: Connection, sql: string, values: unknown[] = []) {
  const [rows] = await connection.query<RowDataPacket[]>({ sql, timeout: 10000 }, values);
  return rows;
}

async function migrateImportData(connection: Connection, data: DataStep) {
  if (data === 'seed-import-sources') {
    await query(connection, `INSERT INTO import_sources (source_namespace,name,created_at)
      SELECT b.source_namespace,b.source_namespace,MIN(b.created_at) FROM import_batches b
      LEFT JOIN import_sources s ON s.source_namespace=b.source_namespace
      WHERE s.source_namespace IS NULL GROUP BY b.source_namespace`);
    const [row] = await query(connection, `SELECT COUNT(*) AS invalid FROM import_batches b
      LEFT JOIN import_sources s ON s.source_namespace=b.source_namespace WHERE s.source_namespace IS NULL`);
    if (Number(row.invalid)) fail('DB_IMPORT_SOURCE_BACKFILL_INVALID');
    return;
  }
  // Only old rows get a frozen namespace. New history always derives its source from an immutable adoption.
  await query(connection, `UPDATE legacy_project_history h JOIN import_items i ON i.id=h.source_import_item_id
    JOIN import_batches b ON b.id=i.batch_id SET h.legacy_source_namespace=b.source_namespace
    WHERE h.source_adoption_id IS NULL AND h.legacy_source_namespace IS NULL`);
  const [row] = await query(connection, `SELECT COUNT(*) AS invalid FROM legacy_project_history h
    LEFT JOIN import_items i ON i.id=h.source_import_item_id LEFT JOIN import_batches b ON b.id=i.batch_id
    WHERE h.source_adoption_id IS NULL AND (b.id IS NULL OR h.legacy_source_namespace IS NULL
      OR h.legacy_source_namespace<>b.source_namespace)`);
  if (Number(row.invalid)) fail('DB_IMPORT_HISTORY_BACKFILL_INVALID');
}

// ponytail: 首版 CHECK 都是单条件；引入复合布尔表达式时需扩展保留分组的规范化。
function normalizeCheck(expression: string) {
  return expression.replace(/\\'/g, "'").split(/('(?:''|[^'])*')/g).map((part, index) => index % 2 ? part
    : part.replace(/_[a-z0-9]+$/i, '').replace(/[`()\s]/g, '').toLowerCase()).join('');
}

async function readStructure(connection: Connection) {
  const tables = await query(connection, 'SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME');
  const columns = await query(connection, 'SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, EXTRA AS extra, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION');
  const indexes = await query(connection, 'SELECT TABLE_NAME AS tbl, INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS col, SUB_PART AS prefix_length, INDEX_TYPE AS type, IS_VISIBLE AS visible, COLLATION AS direction FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX');
  const checks = await query(connection, 'SELECT tc.TABLE_NAME AS tbl, tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS expression, tc.ENFORCED AS enforced FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE = \'CHECK\' ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME');
  const foreign = await query(connection, 'SELECT k.TABLE_NAME AS tbl, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS parent, k.REFERENCED_COLUMN_NAME AS ref, k.REFERENCED_TABLE_SCHEMA AS ref_schema, r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION');
  const [identity] = await query(connection, 'SELECT DATABASE() AS db');
  const result = new Map<string, ActualTable>();
  for (const table of tables) {
    const tbl = table.name as string;
    const indexMap = new Map<string, Index>();
    for (const index of indexes.filter(row => row.tbl === tbl)) {
      if (index.prefix_length !== null || index.type !== 'BTREE' || index.visible !== 'YES' || index.direction !== 'A') fail('DB_INDEX_UNSUPPORTED', [{ table: tbl, object: index.name, expected: '完整可见升序 BTREE 索引', actual: { prefix: index.prefix_length, type: index.type, visible: index.visible, direction: index.direction } }]);
      if (!indexMap.has(index.name)) indexMap.set(index.name, { name: index.name, unique: Number(index.non_unique) === 0, columns: [] });
      indexMap.get(index.name)!.columns.push(index.col);
    }
    const fkMap = new Map<string, Omit<ForeignKey, 'sql'>>();
    for (const fk of foreign.filter(row => row.tbl === tbl)) {
      if (fk.ref_schema !== identity.db) fail('DB_FOREIGN_TARGET_INVALID');
      if (!fkMap.has(fk.name)) fkMap.set(fk.name, { name: fk.name, columns: [], parent: fk.parent, references: [], onUpdate: fk.on_update, onDelete: fk.on_delete });
      fkMap.get(fk.name)!.columns.push(fk.col);
      fkMap.get(fk.name)!.references.push(fk.ref);
    }
    if (checks.some(row => row.tbl === tbl && row.enforced !== 'YES')) fail('DB_CHECK_NOT_ENFORCED');
    // MySQL将TEXT空串默认值标为DEFAULT_GENERATED；只接受这个固定字面量，仍拒绝计算列和动态默认值。
    const emptyTextDefault = (row: RowDataPacket) => row.extra === 'DEFAULT_GENERATED' && row.type === 'text' && row.def === "_utf8mb4\\'\\'";
    if (columns.some(row => row.tbl === tbl && !['', 'auto_increment'].includes(row.extra) && !emptyTextDefault(row))) fail('DB_COLUMN_EXTRA_UNSUPPORTED');
    result.set(tbl, {
      name: tbl, engine: table.engine, collation: table.collation,
      columns: columns.filter(row => row.tbl === tbl).map(row => ({ name: row.name, type: row.type.replace(/(tinyint|smallint|int|bigint)\(\d+\)/g, '$1'), nullable: row.nullable === 'YES', default: emptyTextDefault(row) ? "''" : row.def, autoIncrement: row.extra === 'auto_increment', charset: row.charset, collation: row.collation })),
      indexes: [...indexMap.values()],
      checks: checks.filter(row => row.tbl === tbl).map(row => ({ name: row.name, expression: normalizeCheck(row.expression) })),
      foreignKeys: [...fkMap.values()],
    });
  }
  return result;
}

function compareTable(expected: Table, actual: ActualTable | undefined, requireAllForeignKeys: boolean) {
  const differences: Difference[] = [];
  if (!actual) return [{ table: expected.name, object: 'table', expected: '存在', actual: '缺失' }];
  const compare = (object: string, want: unknown, got: unknown) => {
    if (JSON.stringify(want) !== JSON.stringify(got)) differences.push({ table: expected.name, object, expected: want, actual: got });
  };
  compare('engine', 'InnoDB', actual.engine);
  compare('collation', 'utf8mb4_0900_ai_ci', actual.collation);
  compare('columns', expected.columns, actual.columns);
  const sorted = <T extends { name: string }>(items: T[]) => [...items].sort((a, b) => a.name.localeCompare(b.name));
  compare('indexes', sorted(expected.indexes), sorted(actual.indexes));
  compare('checks', sorted(expected.checks.map(check => ({ name: check.name, expression: normalizeCheck(check.expression) }))), sorted(actual.checks));
  const keys = expected.foreignKeys.map(({ sql: _sql, ...fk }) => fk);
  compare('foreignKeys', sorted(requireAllForeignKeys ? keys : keys.filter(key => actual.foreignKeys.some(fk => fk.name === key.name))), sorted(actual.foreignKeys));
  return differences;
}

async function verifyStructure(connection: Connection, manifest: Manifest) {
  const actual = await readStructure(connection);
  const differences = manifest.tables.flatMap(table => compareTable(table, actual.get(table.name), true));
  for (const name of actual.keys()) if (!manifest.tables.some(table => table.name === name)) differences.push({ table: name, object: 'table', expected: '未定义', actual: '额外对象' });
  if (differences.length) fail('DB_SCHEMA_MISMATCH', differences);
  return { tables: actual.size, columns: [...actual.values()].reduce((n, table) => n + table.columns.length, 0), foreignKeys: [...actual.values()].reduce((n, table) => n + table.foreignKeys.length, 0), differences: 0 };
}

async function checkHistory(connection: Connection, history: Awaited<ReturnType<typeof loadSchema>>['history'], required: boolean) {
  const rows = await query(connection, 'SELECT version, checksum FROM schema_migrations ORDER BY version');
  if (rows.some((row, index) => row.version !== history[index]?.version)) fail('DB_SCHEMA_VERSION_UNSUPPORTED');
  if (rows.some((row, index) => !Buffer.isBuffer(row.checksum) || !row.checksum.equals(history[index].checksum))) fail('DB_MIGRATION_CHECKSUM_MISMATCH');
  if (required && rows.length !== history.length) fail('DB_SCHEMA_VERSION_MISSING');
  return rows.length;
}

export async function verifyDatabase(profile: DatabaseProfile) {
  const { manifest, checksum, history } = await loadSchema();
  const { connection, fact } = await connectDatabase(profile);
  try {
    const structure = await verifyStructure(connection, manifest);
    await checkHistory(connection, history, true);
    return { database: fact.database, version: manifest.version, checksum: checksum.toString('hex'), ...structure };
  } finally { await connection.end(); }
}

export async function verifySchemaConnection(connection: Connection, resource: Awaited<ReturnType<typeof loadSchema>>, full: boolean) {
  const structure = full ? await verifyStructure(connection, resource.manifest) : undefined;
  await checkHistory(connection, resource.history, true);
  return { version: resource.manifest.version, ...structure };
}

export async function migrateDatabase(profile: DatabaseProfile) {
  if (!profile.endsWith('_migrator')) fail('DB_MIGRATION_IDENTITY_INVALID');
  const { manifest: target, foundation: manifest, history, increments } = await loadSchema();
  const { connection, fact } = await connectDatabase(profile);
  const lockName = `geekdash:${fact.database}:schema`;
  let locked = false;
  let step = 'lock';
  let applied = false;
  console.log(JSON.stringify({ event: 'migration_target', database: fact.database, targetVersion: target.version }));
  try {
    const [lock] = await query(connection, 'SELECT GET_LOCK(?, 5) AS acquired', [lockName]);
    if (Number(lock.acquired) !== 1) fail(lock.acquired === null ? 'DB_MIGRATION_LOCK_FAILED' : 'DB_MIGRATION_BUSY');
    locked = true;
    let actual = await readStructure(connection);
    const registry = manifest.tables.find(table => table.name === 'schema_migrations')!;
    step = registry.name;
    if (!actual.has(registry.name)) {
      await query(connection, registry.sql);
      actual = await readStructure(connection);
    }
    const registryDifferences = compareTable(registry, actual.get(registry.name), true);
    if (registryDifferences.length) fail('DB_SCHEMA_MISMATCH', registryDifferences);
    const completed = await checkHistory(connection, history, false);
    if (completed === 0) {
      for (const [name, table] of actual) {
        const expected = manifest.tables.find(want => want.name === name);
        if (!expected) fail('DB_SCHEMA_MISMATCH', [{ table: name, object: 'table', expected: '未定义', actual: '额外对象' }]);
        const differences = compareTable(expected, table, false);
        if (differences.length) fail('DB_SCHEMA_MISMATCH', differences);
      }
      for (const table of manifest.tables) {
        step = table.name;
        if (!actual.has(table.name)) {
          await query(connection, table.sql);
          actual = await readStructure(connection);
        }
        const differences = compareTable(table, actual.get(table.name), false);
        if (differences.length) fail('DB_SCHEMA_MISMATCH', differences);
        console.log(JSON.stringify({ event: 'migration_step_verified', object: table.name }));
      }
      for (const table of manifest.tables) for (const fk of table.foreignKeys) {
        step = fk.name;
        if (!actual.get(table.name)!.foreignKeys.some(key => key.name === fk.name)) {
          await query(connection, fk.sql);
          actual = await readStructure(connection);
        }
        const differences = compareTable(table, actual.get(table.name), false);
        if (differences.length) fail('DB_SCHEMA_MISMATCH', differences);
        console.log(JSON.stringify({ event: 'migration_step_verified', object: fk.name }));
      }
      step = 'final_structure';
      await verifyStructure(connection, manifest);
      console.log(JSON.stringify({ event: 'migration_structure_verified', registered: false }));
      step = 'register_version';
      await query(connection, 'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, UTC_TIMESTAMP(3))', [history[0].version, history[0].checksum]);
      applied = true;
    }
    for (const [index, increment] of increments.entries()) {
      if (completed > index + 1) continue;
      const { manifest: target, previous, steps } = increment;
      // 接受每个已声明步骤的精确中间态，DDL已生效但登记未完成时可以接续。
      actual = await readStructure(connection);
      for (const name of actual.keys()) if (!target.tables.some(table => table.name === name)) fail('DB_SCHEMA_MISMATCH', [{ table: name, object: 'table', expected: '未定义', actual: '额外对象' }]);
      for (const table of target.tables) {
        const differences = compareTable(table, actual.get(table.name), true);
        if (!differences.length) continue;
        const old = previous.tables.find(old => old.name === table.name);
        const states = [old, ...steps.filter(step => step.table === table.name).map(step => step.after)];
        if (!states.some(state => state ? !compareTable(state, actual.get(table.name), true).length : !actual.has(table.name))) fail('DB_SCHEMA_MISMATCH', differences);
      }
      for (const [stepIndex, increment] of steps.entries()) {
        step = increment.data ?? `${increment.table}:${stepIndex + 1}`;
        if (increment.data) {
          await migrateImportData(connection, increment.data);
          console.log(JSON.stringify({ event: 'migration_step_verified', object: step }));
          continue;
        }
        const current = actual.get(increment.table);
        const alreadyApplied = steps.slice(stepIndex).some(later => later.table === increment.table && !compareTable(later.after, current, true).length);
        if (!alreadyApplied) {
          const differences = increment.before ? compareTable(increment.before, current, true) : current ? [{ table: increment.table, object: 'table', expected: '缺失', actual: '存在' }] : [];
          if (differences.length) fail('DB_SCHEMA_MISMATCH', differences);
          await query(connection, increment.sql!);
          actual = await readStructure(connection);
          const afterDifferences = compareTable(increment.after, actual.get(increment.table), true);
          if (afterDifferences.length) fail('DB_SCHEMA_MISMATCH', afterDifferences);
        }
        console.log(JSON.stringify({ event: 'migration_step_verified', object: step }));
      }
      step = 'final_structure';
      await verifyStructure(connection, target);
      console.log(JSON.stringify({ event: 'migration_structure_verified', registered: false }));
      step = 'register_increment';
      await query(connection, 'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, UTC_TIMESTAMP(3))', [history[index + 1].version, history[index + 1].checksum]);
      applied = true;
    }
    return { status: 'verified', applied, ...await verifyDatabase(profile) };
  } catch (error) {
    throw Object.assign(error as Error, { migrationStep: step, result: '未完整验收；可能存在已生效结构，重新核对后接续' });
  } finally {
    try { if (locked) await query(connection, 'SELECT RELEASE_LOCK(?) AS released', [lockName]); }
    finally { connection.destroy(); }
  }
}
