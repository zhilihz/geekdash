import { connectDatabase } from '../infrastructure/db.js';
import { verifyDatabase } from '../infrastructure/schema.js';
import { stages } from '../modules/projects.js';
import type { RowDataPacket } from 'mysql2/promise';

const profile = process.argv[2] ?? 'dev_migrator';
try {
  if (!['dev_migrator', 'test_migrator'].includes(profile)) throw new Error('DB_PROFILE_INVALID');
  const target = profile as 'dev_migrator' | 'test_migrator';
  await verifyDatabase(target);
  const { connection } = await connectDatabase(target);
  try {
    await connection.beginTransaction();
    // 明确合成候选；重复运行只复用原 ID，不改名、启用或覆盖已保存资料。
    const referenceIds: Record<string, string[]> = {};
    for (const [table, fields] of Object.entries({ apps: ['app_version', 'description'], chips: ['original_model', 'manufacturer', 'firmware_version'], customers: ['contact', 'background'], engineers: ['role'], product_lines: [], project_groups: [], tags: [] })) {
      referenceIds[table] = [];
      for (const index of [1, 2]) {
        const name = `[合成试用] ${table} ${index}`;
        let [rows] = await connection.query<RowDataPacket[]>(`SELECT CAST(id AS CHAR) id FROM ${table} WHERE name=? FOR UPDATE`, [name]);
        if (rows.length > 1) throw new Error('TRIAL_REFERENCE_AMBIGUOUS');
        if (!rows.length) {
          await connection.execute(`INSERT INTO ${table} (name,${fields.map(field => field + ',').join('')}created_at,updated_at) VALUES (?${fields.map(() => ',?').join('')},UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [name, ...fields.map(field => field === 'original_model' ? 'SYNTHETIC-' + index : field === 'manufacturer' ? '合成厂商' : '')]);
          [rows] = await connection.query<RowDataPacket[]>(`SELECT CAST(id AS CHAR) id FROM ${table} WHERE name=?`, [name]);
        }
        referenceIds[table].push(rows[0].id);
      }
    }
    // 唯一来源键保证重跑不会重置人工文字；只补尚不存在的完整项目。
    const samples = [];
    for (const [key, name, signal] of [['01', '合成测试 · 智能家居方案', 'green'], ['02', '合成测试 · 穿戴方案', 'yellow'], ['03', '合成测试 · 网关方案', 'red']]) {
      await connection.execute(`INSERT INTO projects (name,data_kind,source_namespace,source_key,status,\`signal\`,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,created_at,updated_at)
        VALUES (?,'trial','geekdash-trial-v1',?,'ongoing',?,'合成测试数据','用于四项保存试用','待测试','请在此输入详细说明','用于查看摘要','','','',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id=id`, [name, key, signal]);
      const [rows] = await connection.query<RowDataPacket[]>("SELECT CAST(id AS CHAR) id,data_kind FROM projects WHERE source_namespace='geekdash-trial-v1' AND source_key=? FOR UPDATE", [key]);
      if (rows[0].data_kind !== 'trial') throw new Error('TRIAL_SOURCE_COLLISION');
      for (const stage of stages) await connection.execute('INSERT INTO project_stages (project_id,stage_code,state,note) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=id', [rows[0].id, stage.code, stage.code === 'S1' ? 'ready' : 'locked', '合成测试阶段']);
      samples.push(rows[0].id);
    }
    await connection.commit();
    console.log(JSON.stringify({ status: 'verified', profile, projectIds: samples, referenceIds, source: 'synthetic' }));
  } catch (error) { await connection.rollback(); throw error; }
  finally { await connection.end(); }
} catch (error) { console.error(JSON.stringify({ status: 'failed', code: (error as { code?: string }).code ?? (error as Error).message })); process.exitCode = 1; }
