import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseImportSource, importSourceKey } from '../src/server/modules/import-source.ts';

const source = {
  version: 2, appVersion: 'V1.054', projects: [
    { id: 7, name: '解析验证', customer: '客户甲', hwOwner: '甲', participants: ['甲'], chips: [],
      stages: [{ done: true }, { done: false }], statusDesc: '', statusDescHistory: [{ date: '', text: '' }],
      risks: [{ id: 0, content: '保留未知时间' }], customUnknown: { keep: true } },
    { id: 8, name: '第二个项目', customer: '客户甲', tags: [] },
  ], customers: [], engineers: [], company: { fullName: '', manager: '原负责人' },
  preferences: { hw_project_board_summary_notes: JSON.stringify({ 7: '简要备注' }), hw_project_board_chipstat_notes: JSON.stringify({ 7: '' }) },
};
const text = JSON.stringify(source), parsed = parseImportSource(text), project = parsed.items.find(item => item.kind === 'project');
assert.equal(parsed.format, 'json');
assert.deepEqual(parsed.raw, source, '原容器和未知字段必须保留');
assert.equal(project.sourceKey, '7');
assert.ok(!project.present.includes('priority') && !project.present.includes('status') && !project.present.includes('startDate'), '缺字段不能补默认值');
assert.deepEqual(project.raw.chips, []);
assert.deepEqual(project.raw.stages, source.projects[0].stages);
assert.deepEqual(project.raw.statusDescHistory, [{ date: '', text: '' }]);
assert.ok(!Object.hasOwn(project.raw.risks[0], 'createdAt'));
assert.equal(project.raw.summary_note, '简要备注'); assert.equal(project.raw.chipstat_note, '');
assert.equal(parsed.items.filter(item => item.kind === 'customers').length, 1, '同类相同原名称集中一项');
assert.equal(parsed.items.find(item => item.kind === 'customers').sourceKey, null, '名称候选不是永久绑定');
assert.equal(parsed.items.find(item => item.kind === 'customers').originPaths.length, 2);
assert.equal(parsed.items.filter(item => item.kind === 'engineers').length, 1);
assert.equal(parsed.items.find(item => item.kind === 'company').raw.manager, '原负责人');
assert.deepEqual(parseImportSource(Buffer.from(text).toString('base64')).items, parsed.items);
assert.deepEqual(parseImportSource(new TextEncoder().encode('\uFEFF' + text)).items, parsed.items);
const invalid = parseImportSource(JSON.stringify({ projects: [{ id: 1, name: '一' }, { id: '01', name: '二' }, { id: 0 }, null] }));
assert.equal(invalid.items.filter(item => item.kind === 'project').length, 4);
assert.ok(invalid.items.every(item => item.sourceKey === null));
assert.equal(invalid.items[0].issues[0].code, 'IMPORT_SOURCE_KEY_DUPLICATE');
assert.equal(invalid.items[3].issues[0].severity, 'error');
assert.equal(parseImportSource('{"projects":[{"id":9007199254740993,"name":"大编号"}]}').items[0].sourceKey, '9007199254740993');
assert.equal(importSourceKey(-1), null); assert.equal(importSourceKey('0'), null);
assert.equal(importSourceKey('0012'), '12'); assert.equal(importSourceKey('9'.repeat(129)), null);
assert.throws(() => parseImportSource('{bad'), { code: 'IMPORT_FORMAT_INVALID' });
assert.throws(() => parseImportSource('{"projects":[],"version":99}'), { code: 'IMPORT_VERSION_UNSUPPORTED' });
assert.throws(() => parseImportSource(new Uint8Array([0xff, 0xfe])), { code: 'IMPORT_ENCODING_INVALID' });
assert.ok(!Object.hasOwn(parseImportSource('{"projects":[{"id":1}],"preferences":{"hw_project_board_summary_notes":"bad"}}').items[0].raw, 'summary_note'));
const ambiguous = parseImportSource('{"projects":[{"id":1,"summary_note":"正文"}],"preferences":{"hw_project_board_summary_notes":"{\\"1\\":\\"另一份\\"}"}}');
assert.equal(ambiguous.items[0].raw.summary_note, '正文');
assert.equal(ambiguous.items[0].issues[0].code, 'IMPORT_NOTES_AMBIGUOUS');

// Read-only optional source validation reports counts, never names or business contents.
if (process.argv[2]) {
  const real = parseImportSource(await readFile(process.argv[2]));
  console.log(JSON.stringify({ check: 'source-read-only', format: real.format, version: real.version,
    itemCounts: Object.fromEntries([...new Set(real.items.map(item => item.kind))].map(kind => [kind, real.items.filter(item => item.kind === kind).length])),
    issues: real.issues.map(item => item.code) }));
}
console.log(JSON.stringify({ check: 'import-source-presence-and-recovery', status: 'passed' }));
