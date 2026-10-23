import assert from 'node:assert/strict';

// 领域验收走真实执行 HTTP 接口；只把异步结果转换为现有业务断言使用的形状。
export async function executeImport(api, target, body, expected = 200) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  const route = `/api/imports/${target.batchId}/executions`;
  const request = { idempotencyKey: body.idempotencyKey, items: [{ id: target.itemId, command: body }] };
  const accepted = await api(route, 'POST', request, [...new Set([202, ...allowed])]);
  if (!accepted.id) return accepted;
  for (let attempt = 0; attempt < 200; attempt++) {
    const execution = await api(route + '?operation=' + body.idempotencyKey);
    const item = execution.items.find(row => row.id === target.itemId);
    if (item?.status === 'committed') {
      assert(allowed.includes(200), JSON.stringify(item));
      return { outcome: 'committed', result: item.result };
    }
    if (item?.status === 'failed') {
      assert(allowed.includes(item.statusCode), JSON.stringify(item));
      return { outcome: 'rejected', code: item.code, fields: item.fields };
    }
    if (item?.status === 'confirming' && allowed.includes(503)) return { outcome: 'unknown', code: item.code };
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('服务器未在验收等待期内完成导入执行');
}
