import { syncReferencePickers } from './reference-picker';

const tables:Record<string,string>={customerId:'customers',odmCustomerId:'customers',productLineId:'product_lines',appId:'apps',groupId:'project_groups',chipIds:'chips',tagIds:'tags',people:'engineers',inviteeIds:'managerAccounts'};

// 更新候选而不重建输入框；已选 option 节点也保留，供移除按钮继续引用。
export function refreshProjectOptions(root:ParentNode,render:(key:string,table:string,role?:string)=>string){
  root.querySelectorAll<HTMLSelectElement>('select[data-reference="true"]').forEach(source=>{
    const field=source.id.replace(/^edit-|-source$/g,''),key=field.startsWith('people-')?'people':field,table=tables[key];
    if(!table)return;
    const template=source.ownerDocument.createElement('template');template.innerHTML=render(key,table,key==='people'?field.slice(7):undefined);
    const options=[...template.content.querySelectorAll('option')],selected=options.map(option=>option.selected),existing=new Map([...source.options].map(option=>[option.value,option]));
    const next=options.map(option=>{const current=existing.get(option.value) ?? option;current.textContent=option.textContent;current.disabled=option.disabled;return current;});
    source.replaceChildren(...next);
    next.forEach((option,index)=>{option.selected=selected[index];});
  });
  syncReferencePickers(root);
}
