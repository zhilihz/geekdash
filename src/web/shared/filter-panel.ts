import {esc} from './api';
import './filter-panel.css';

export type FilterChoice=[string,string];
export const toggleFilter=(selected:string[],value:string)=>!value?[]:selected.includes(value)?selected.filter(item=>item!==value):[...selected,value];

export function projectFilters(host:HTMLElement,prefix:string,titles:Record<string,string>,onLayout:()=>void){
  const id=(name:string)=>prefix+name;
  host.classList.add('toolbar-panel','project-filter-panel');
  host.innerHTML=`<label class="read-label" for="${id('search')}">搜索项目</label><input id="${id('search')}" type="search" maxlength="255" placeholder="项目名称 / 客户 / 芯片 / 人员"><div class="filter-head"><button class="filter-toggle" id="${id('filter-toggle')}" aria-controls="${id('filter-rows')}" aria-expanded="false">▸ 展开筛选</button><button class="head-btn" id="${id('filter-settings')}" aria-controls="${id('filter-settings-panel')}" aria-expanded="false">设置筛选</button><button class="head-btn" id="${id('clear')}" data-clear-filters>清空筛选</button></div><div id="${id('filter-settings-panel')}" class="filter-settings-panel" hidden></div><div id="${id('selected-filters')}" class="selected-filter-chips" aria-label="已选条件" hidden></div><div id="${id('filter-rows')}" class="filter-groups" hidden></div>`;
  const get=(name:string)=>document.getElementById(id(name))!;
  const layout={order:[...Object.keys(titles),'contentDate'],hidden:[] as string[]};
  const title=(key:string)=>key==='contentDate'?'内容更新时间':titles[key];
  const settings=get('filter-settings-panel');
  function showSettings(){
    settings.innerHTML=layout.order.map((key,i)=>`<div class="filter-setting"><label><input type="checkbox" data-filter-visible="${key}" ${layout.hidden.includes(key)?'':'checked'}>${esc(title(key))}</label><button class="head-btn" data-filter-move="${key}" data-direction="-1" ${i===0?'disabled':''} aria-label="上移${esc(title(key))}">↑</button><button class="head-btn" data-filter-move="${key}" data-direction="1" ${i===layout.order.length-1?'disabled':''} aria-label="下移${esc(title(key))}">↓</button></div>`).join('');
  }
  get('filter-settings').onclick=()=>{settings.hidden=!settings.hidden;get('filter-settings').setAttribute('aria-expanded',String(!settings.hidden));if(!settings.hidden)showSettings();};
  settings.onchange=e=>{const input=e.target as HTMLInputElement,key=input.dataset.filterVisible;if(!key)return;layout.hidden=layout.hidden.filter(v=>v!==key);if(!input.checked)layout.hidden.push(key);onLayout();};
  settings.onclick=e=>{const button=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-filter-move]');if(!button||button.disabled)return;const a=layout.order.indexOf(button.dataset.filterMove!),b=a+Number(button.dataset.direction);[layout.order[a],layout.order[b]]=[layout.order[b],layout.order[a]];showSettings();onLayout();};
  return {
    layout,
    restore(order:unknown,hidden:unknown){const keys=[...Object.keys(titles),'contentDate'];layout.order=[...new Set([...(Array.isArray(order)?order.filter(key=>keys.includes(key)):[]),...keys])];layout.hidden=Array.isArray(hidden)?hidden.filter(key=>keys.includes(key)):[];},
    expand(open:boolean){get('filter-rows').hidden=!open;get('filter-toggle').textContent=open?'▾ 收起筛选':'▸ 展开筛选';get('filter-toggle').setAttribute('aria-expanded',String(open));},
    selected(items:{key:string;text:string;value?:string}[]){const box=get('selected-filters');box.hidden=!items.length;box.innerHTML=items.map(item=>`<button class="chip active" data-remove-filter="${esc(item.key)}" ${item.value===undefined?'':`data-value="${esc(item.value)}"`} aria-label="取消${esc(item.text)}">${esc(item.text)} <span aria-hidden="true">×</span></button>`).join('');},
    render(options:Record<string,FilterChoice[]>,getSelected:(key:string)=>string[],from:string,to:string){
      get('filter-rows').innerHTML=layout.order.map(key=>{
        const selected=getSelected(key),isDate=key==='contentDate';
        const hide=layout.hidden.includes(key)&&!(isDate?from||to:selected.length)?' hidden':'';
        if(isDate)return `<div class="filter-row" data-dimension="contentDate"${hide}><span class="filter-label">内容更新时间</span><label>从 <input type="date" data-content-date="contentFrom" value="${esc(from)}" max="${esc(to)}"></label><label>至 <input type="date" data-content-date="contentTo" value="${esc(to)}" min="${esc(from)}"></label><span>按说明与任务修改日期筛选</span></div>`;
        const labels=new Map(options[key]??[]),values=[...new Set([...labels.keys(),...selected])];
        return `<div class="filter-row" data-dimension="${key}" role="group" aria-label="${esc(title(key))}"${hide}><span class="filter-label">${esc(title(key))}</span><button class="chip ${selected.length?'':'active'}" data-filter="${key}" data-value="" aria-pressed="${!selected.length}">全部</button>${values.map(value=>`<button class="chip ${selected.includes(value)?'active':''}" data-filter="${key}" data-value="${esc(value)}" aria-pressed="${selected.includes(value)}">${esc(labels.get(value)??value)}</button>`).join('')}</div>`;
      }).join('');
    }
  };
}
