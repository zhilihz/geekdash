import { esc, type Catalog, type ChipSelection } from './api';

export function chipPicker(selected: ChipSelection[], catalog?: Catalog) {
  return `<div class="chip-picker" id="chip-picker"><div class="chip-picker-selected">${selected.map(item => {
    const name = catalog?.chips?.find(chip => chip.id === item.chipId)?.name ?? item.chipId;
    const title = name + (item.note ? `（${item.note}）` : '');
    return `<span class="project-chip-tag" data-chip-id="${esc(item.chipId)}" data-chip-note="${esc(item.note)}"><span>${esc(title)}</span><button type="button" data-chip-remove="${esc(item.selectionId)}" aria-label="移除${esc(title)}">×</button></span>`;
  }).join('')}</div><div class="chip-picker-actions"><select id="chip-model" data-edit aria-label="芯片型号"><option value="">请选择芯片型号</option>${(catalog?.chips ?? []).filter(item => item.enabled).map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join('')}</select><input id="chip-note" data-edit placeholder="备注（选填）" aria-label="芯片备注"><button type="button" class="back-btn" id="chip-add">＋ 添加所选</button><button type="button" class="back-btn" id="chip-refresh">刷新芯片库</button><a class="back-btn" href="/data-manage.html?kind=chips" target="_blank" rel="noopener">前往基础信息新增</a></div><p class="field-error" id="chip-message" role="status"></p></div>`;
}

export function bindChipPicker(read: () => ChipSelection[], write: (value: ChipSelection[]) => void, catalog: () => Catalog | undefined, refresh: () => Promise<void>) {
  const root = document.getElementById('chip-picker');
  if (!root) return;
  const render = () => { root.outerHTML = chipPicker(read(),catalog()); bindChipPicker(read,write,catalog,refresh); };
  document.getElementById('chip-add')!.onclick = () => {
    const select = document.getElementById('chip-model') as HTMLSelectElement;
    const note = document.getElementById('chip-note') as HTMLInputElement;
    if (!select.value) { document.getElementById('chip-message')!.textContent = '请选择芯片型号。'; select.focus(); return; }
    write([...read(),{selectionId:crypto.randomUUID(),chipId:select.value,note:note.value.trim()}]); render();
  };
  root.querySelectorAll<HTMLButtonElement>('[data-chip-remove]').forEach(button => button.onclick = () => { write(read().filter(item => item.selectionId !== button.dataset.chipRemove)); render(); });
  document.getElementById('chip-refresh')!.onclick = async () => {
    const note=(document.getElementById('chip-note') as HTMLInputElement).value;
    const model=(document.getElementById('chip-model') as HTMLSelectElement).value;
    try { await refresh(); render(); (document.getElementById('chip-note') as HTMLInputElement).value=note; (document.getElementById('chip-model') as HTMLSelectElement).value=model; }
    catch (error) { document.getElementById('chip-message')!.textContent=(error as Error).message; }
  };
}

export function refreshChipOptions(catalog?: Catalog) {
  const select=document.getElementById('chip-model') as HTMLSelectElement|null;
  if (!select) return;
  const previous=select.value;
  select.replaceChildren(new Option('请选择芯片型号',''),...(catalog?.chips??[]).filter(item=>item.enabled).map(item=>new Option(item.name,item.id)));
  select.value=previous;
  document.querySelectorAll<HTMLElement>('.project-chip-tag[data-chip-id]').forEach(tag => {
    const name=catalog?.chips?.find(chip=>chip.id===tag.dataset.chipId)?.name;
    if (!name) return;
    const title=name+(tag.dataset.chipNote ? `（${tag.dataset.chipNote}）` : '');
    tag.querySelector('span')!.textContent=title;
    tag.querySelector('button')?.setAttribute('aria-label','移除'+title);
  });
}
