import './status-mentions.css';

type Person={name:string;role?:string};
export function attachStatusMentions(input:HTMLTextAreaElement,people:()=>Person[]){
  if(input.dataset.statusMentions)return;
  input.dataset.statusMentions='true';
  const wrap=document.createElement('div');wrap.className='status-mention-wrap';input.before(wrap);wrap.append(input);
  const menu=document.createElement('div');menu.className='status-mention-menu';menu.id='status-mentions-'+crypto.randomUUID();menu.hidden=true;menu.setAttribute('role','listbox');wrap.append(menu);
  input.setAttribute('aria-controls',menu.id);input.setAttribute('aria-autocomplete','list');
  let matches:Person[]=[],active=0,composing=false;
  const token=()=>input.value.slice(0,input.selectionStart).match(/@([^\s@，,。；;：:！？!?（）()\[\]【】、<>]*)$/u);
  const close=()=>{menu.hidden=true;input.removeAttribute('aria-activedescendant');};
  function render(keep=false){
    if(composing)return;
    const found=token();if(!found || input.readOnly || input.disabled){close();return;}
    const keyword=found[1].toLowerCase();matches=people().filter(person=>person.name.toLowerCase().includes(keyword)).slice(0,8);
    if(!keep)active=0;menu.replaceChildren();
    for(const [i,person] of matches.entries()){
      const button=document.createElement('button');button.type='button';button.id=menu.id+'-'+i;button.dataset.mentionName=person.name;button.setAttribute('role','option');button.setAttribute('aria-selected',String(i===active));button.textContent=person.name+(person.role?' · '+person.role:'');menu.append(button);
    }
    menu.hidden=!matches.length;
    if(matches.length)input.setAttribute('aria-activedescendant',menu.id+'-'+active);else input.removeAttribute('aria-activedescendant');
  }
  function choose(name:string){
    if(!token() || input.readOnly || input.disabled)return;
    input.setRangeText('@'+name+' ',input.value.slice(0,input.selectionStart).lastIndexOf('@'),input.selectionStart,'end');
    input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();close();
  }
  input.addEventListener('input',()=>render());
  input.addEventListener('click',()=>render());
  input.addEventListener('compositionstart',()=>{composing=true;close();});
  input.addEventListener('compositionend',()=>{composing=false;render();});
  input.addEventListener('keydown',event=>{
    if(composing || event.isComposing)return;
    if(event.key==='Escape'){close();return;}
    if(menu.hidden || !matches.length)return;
    if(event.key==='ArrowDown' || event.key==='ArrowUp'){event.preventDefault();active=(active+(event.key==='ArrowDown'?1:matches.length-1))%matches.length;render(true);}
    else if(event.key==='Enter'){event.preventDefault();choose(matches[active].name);}
  });
  // 保持输入焦点，让候选按钮一直留在原处直到本次点击结束。
  menu.addEventListener('mousedown',event=>{if(event.button===0)event.preventDefault();});
  menu.addEventListener('click',event=>{
    event.stopPropagation();
    const option=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-mention-name]');
    if(!menu.hidden && option && event.button===0)choose(option.dataset.mentionName!);
  });
  input.addEventListener('blur',close);
}
