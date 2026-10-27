import type { EditValues, SaveRequest, SaveScope } from './api';

export const scopeFields: Record<SaveScope, (keyof EditValues)[]> = {
  project: ['name','summary','marketExpectation','detailNote','summaryNote','chipstatNote','statusDesc','signal','signalNote','priority','customerIds','odmFactoryIds','productLineIds','appIds','groupIds','chipSelections','tagIds','people','stagePlans','riskOps','nodeOps','changeOps','taskOps'],
  basic: ['name', 'summary', 'marketExpectation', 'detailNote', 'priority', 'customerIds', 'odmFactoryIds', 'productLineIds', 'appIds', 'groupIds', 'chipSelections', 'tagIds', 'people'],
  status: ['statusDesc','taskOps'], tags: ['tagIds'], signal: ['signal', 'signalNote'], summaryNote: ['summaryNote'], chipstatNote: ['chipstatNote'],
  stage: ['stagePlans'], risk: ['riskOps'], change: ['changeOps'], customerNode: ['nodeOps'], projectNodes: ['nodeOps'],
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function scopeChanges(base: EditValues, value: EditValues, scope: SaveScope, target?: string): Partial<EditValues> {
  if (scope === 'stage') {
    const plan = value.stagePlans?.find(item => item.code === target);
    return plan && !equal(plan, base.stagePlans?.find(item => item.code === target)) ? { stagePlans: [structuredClone(plan)] } : {};
  }
  return Object.fromEntries(scopeFields[scope].filter(key => !equal(base[key], value[key])).map(key => [key, structuredClone(value[key])])) as Partial<EditValues>;
}

// 只消去原请求已提交的输入。其他区及提交后继续输入的值仍相对新基线保持未保存。
export function carryInputs(oldBase: EditValues, input: EditValues, newBase: EditValues, request?: SaveRequest): EditValues {
  const next = structuredClone(newBase);
  for (const key of Object.keys(oldBase) as (keyof EditValues)[]) {
    if (key === 'stagePlans') {
      next.stagePlans = newBase.stagePlans?.map(plan => {
        const edited = input.stagePlans?.find(item => item.code === plan.code);
        const old = oldBase.stagePlans?.find(item => item.code === plan.code);
        const submitted = request?.changes.stagePlans?.find(item => item.code === plan.code);
        return edited && !equal(old, edited) && !equal(submitted, edited) ? structuredClone(edited) : plan;
      });
    } else if (key === 'riskOps' || key === 'nodeOps' || key === 'changeOps' || key === 'taskOps') {
      const submitted = request?.changes[key] ?? [];
      const remaining = [...(input[key] ?? [])];
      for (const op of submitted) { const index = remaining.findIndex(item => equal(item, op)); if (index !== -1) remaining.splice(index, 1); }
      Object.assign(next, { [key]: structuredClone(remaining) });
    } else if (!equal(oldBase[key], input[key]) && (!request || !Object.hasOwn(request.changes, key) || !equal(request.changes[key], input[key]))) {
      Object.assign(next, { [key]: structuredClone(input[key]) });
    }
  }
  return next;
}
