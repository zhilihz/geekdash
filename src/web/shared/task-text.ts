import type { ProjectTask, TaskOperation } from './api';

export const validTaskDraft=(value:unknown):boolean=>value===undefined||Array.isArray(value)&&value.every(op=>op&&typeof op.id==='string'&&['add','edit','complete','reopen','delete'].includes(op.op)&&(!['add','edit'].includes(op.op)||typeof op.text==='string'));

// 沿用1056的相同行锚点和段内顺序；有歧义时保留整栏输入，不猜测删除对象。
export function taskRows(tasks:ProjectTask[],text:string):{id?:string;text:string}[] {
  const old=tasks.filter(task=>!task.completedAt&&!task.deletedAt);
  const lines=text.replace(/\r\n?/g,'\n').split('\n').map(line=>line.replace(/^\s*\d+[、.．)）]\s*/,'').trim()).filter(Boolean);
  for(const task of old.filter(task=>task.text.includes('\n'))){
    const parts=task.text.split('\n').map(line=>line.trim()).filter(Boolean);
    for(let i=0;i<=lines.length-parts.length;i++)if(parts.every((part,j)=>part===lines[i+j])){lines.splice(i,parts.length,task.text);break;}
  }
  for(const task of old){const count=old.filter(row=>row.text===task.text).length;if(count>1&&lines.filter(line=>line===task.text).length!==count)throw new Error('有内容相同的任务，无法确认要修改哪一条。输入已保留，请切回逐条编辑处理这些任务。');}
  // ponytail: 沿用本地版LCS；超大整栏先提示分次编辑，避免阻塞浏览器，不限制项目或任务总数。
  if(old.length*lines.length>1_000_000)throw new Error('本次整栏涉及的任务过多，请分次编辑或切回逐条编辑。输入已保留。');
  const dp=Array.from({length:old.length+1},()=>new Uint32Array(lines.length+1));
  for(let i=old.length-1;i>=0;i--)for(let j=lines.length-1;j>=0;j--)dp[i][j]=old[i].text===lines[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const anchors:[number,number][]=[];let i=0,j=0;
  while(i<old.length&&j<lines.length){if(old[i].text===lines[j]){anchors.push([i++,j++]);}else if(dp[i+1][j]>=dp[i][j+1])i++;else j++;}
  anchors.push([old.length,lines.length]);
  const result:{id?:string;text:string}[]=[];let a=0,b=0;
  for(const [endA,endB] of anchors){
    const before=old.slice(a,endA),after=lines.slice(b,endB);
    if(before.length>1&&after.length>0&&before.length!==after.length)throw new Error('多条任务同时替换后无法确认对应关系。输入已保留，请逐条修改或删除这些任务。');
    after.forEach((value,k)=>result.push({id:before[k]?.id,text:value}));
    if(endA<old.length)result.push({id:old[endA].id,text:lines[endB]});
    a=endA+1;b=endB+1;
  }
  return result;
}
export function bulkTaskOperations(tasks:ProjectTask[],text:string):TaskOperation[] {
  const rows=taskRows(tasks,text),ids=new Set(rows.map(row=>row.id)),ops:TaskOperation[]=[];
  for(const row of rows){if(!row.id)ops.push({op:'add',id:crypto.randomUUID(),text:row.text});else if(tasks.find(task=>task.id===row.id)?.text!==row.text)ops.push({op:'edit',id:row.id,text:row.text});}
  for(const task of tasks)if(!task.completedAt&&!task.deletedAt&&!ids.has(task.id))ops.push({op:'delete',id:task.id});
  return ops;
}
