import { createReadStream } from 'node:fs';
import { readdir, realpath, stat, open, link, unlink, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RowDataPacket } from 'mysql2/promise';
import { connectDatabase } from '../infrastructure/db.js';
import { importDirectory } from '../modules/imports.js';

// 只读核对数据库引用与持久卷；异常文件保留现场，不在发布中自动清理。
export async function verifyImportFiles(profile: 'rds_app' | 'test_app', probeStorage = false) {
  if (!['rds_app', 'test_app'].includes(profile)) throw new Error('IMPORT_FILES_PROFILE_INVALID');
  const { connection } = await connectDatabase(profile);
  try {
    const directory = await realpath(importDirectory());
    if (probeStorage) {
      const source = resolve(directory, '.probe-' + randomUUID()), target = source + '.link';
      let created = false;
      try {
        const handle = await open(source, 'wx', 0o600); created = true;
        try { await handle.writeFile('geekdash-storage-probe'); await handle.sync(); } finally { await handle.close(); }
        await link(source, target);
        if ((await readFile(target, 'utf8')) !== 'geekdash-storage-probe') throw new Error('IMPORT_STORAGE_PROBE_FAILED');
      } finally {
        await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (created) await unlink(source);
      }
    }
    const [rows] = await connection.query<RowDataPacket[]>('SELECT CAST(id AS CHAR) id,source_file_ref file,source_hash hash,source_bytes bytes FROM import_batches ORDER BY id');
    const referenced = new Set<string>();
    const failures: { batchId: string; code: string }[] = [];
    for (const row of rows) {
      try {
        const file = await realpath(row.file);
        const path = relative(directory, file);
        if (isAbsolute(path) || path === '..' || path.startsWith('../') || path.startsWith('..\\')) throw new Error('IMPORT_FILE_OUTSIDE_VOLUME');
        const metadata = await stat(file);
        if (!metadata.isFile() || String(metadata.size) !== String(row.bytes)) throw new Error('IMPORT_FILE_SIZE_MISMATCH');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        if (!hash.digest().equals(row.hash)) throw new Error('IMPORT_FILE_HASH_MISMATCH');
        referenced.add(file);
      } catch (error) {
        const problem = error as { code?: string; message?: string };
        failures.push({ batchId: row.id, code: problem.code === 'ENOENT' ? 'IMPORT_FILE_MISSING' : problem.message?.startsWith('IMPORT_FILE_') ? problem.message : 'IMPORT_FILE_UNREADABLE' });
      }
    }
    const files = await readdir(directory, { withFileTypes: true });
    return { status: failures.length ? 'failed' : 'verified', storageProbe: probeStorage, checked: rows.length, failures,
      partialFiles: files.filter(file => file.isFile() && file.name.endsWith('.partial')).length,
      unreferencedFiles: files.filter(file => file.isFile() && file.name.endsWith('.bak') && !referenced.has(resolve(directory, file.name))).length };
  } finally { await connection.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const profile = process.argv[2];
    if (!['rds_app', 'test_app'].includes(profile) || process.argv.length > 4 || process.argv[3] && process.argv[3] !== '--probe-storage') throw new Error('IMPORT_FILES_PROFILE_INVALID');
    const result = await verifyImportFiles(profile as 'rds_app' | 'test_app', process.argv[3] === '--probe-storage');
    console.log(JSON.stringify(result));
    if (result.status !== 'verified') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: (error as { code?: string }).code ?? 'IMPORT_FILES_CHECK_FAILED' }));
    process.exitCode = 1;
  }
}
