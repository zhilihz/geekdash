import type { RowDataPacket } from 'mysql2/promise';
import { connectDatabase } from '../infrastructure/db.js';
import { verifyDatabase } from '../infrastructure/schema.js';

// 只生成核对清单，不猜测旧文字来源、不回写计划、不按姓名授权。
const profile = process.argv[2] ?? 'dev_migrator';
try {
  if (profile !== 'dev_migrator' && profile !== 'test_migrator') throw Object.assign(new Error('DB_PROFILE_INVALID'), { code: 'DB_PROFILE_INVALID' });
  const structure = await verifyDatabase(profile);
  const { connection } = await connectDatabase(profile);
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT');
    const [notes] = await connection.query<RowDataPacket[]>("SELECT CAST(id AS CHAR) projectId FROM projects WHERE summary_note<>'' ORDER BY id");
    const [plans] = await connection.query<RowDataPacket[]>(`SELECT CAST(s.project_id AS CHAR) projectId,s.stage_code stageCode,
      DATE_FORMAT(s.expected_end_on,'%Y-%m-%d') legacyExpectedEndOn,DATE_FORMAT(MAX(n.target_date),'%Y-%m-%d') expectedEndOn,
      COUNT(n.id) nodeCount,SUM(n.id IS NOT NULL AND n.target_date IS NULL) undatedNodeCount
      FROM project_stages s LEFT JOIN project_nodes n ON n.project_id=s.project_id AND n.stage_id=s.id AND n.kind='project' AND n.deleted_at IS NULL
      WHERE s.expected_end_on IS NOT NULL GROUP BY s.id ORDER BY s.project_id,s.stage_code`);
    const [managers] = await connection.query<RowDataPacket[]>("SELECT CAST(project_id AS CHAR) projectId,CAST(engineer_id AS CHAR) engineerId FROM project_people WHERE role='pm' ORDER BY project_id,engineer_id");
    await connection.commit();
    console.log(JSON.stringify({ status: 'review_required', structure, changesApplied: false,
      summarySources: notes.map(row => ({ ...row, field: 'summary_note', status: 'source_review_required', retained: true })),
      stagePlans: plans.map(row => ({ ...row, differs: row.legacyExpectedEndOn !== row.expectedEndOn })),
      legacyManagers: managers.map(row => ({ ...row, status: 'legacy_engineer_reference', grantsPermission: false })) }));
  } finally { await connection.end(); }
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: (error as { code?: string }).code ?? 'COMPATIBILITY_REVIEW_FAILED' }));
  process.exitCode = 1;
}
