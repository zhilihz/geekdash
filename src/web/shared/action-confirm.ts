/** 确认只返回选择，业务调用者在等待结束后重新核对当前可编辑状态。 */
export function confirmAction(title:string,message:string,keepLabel:string,confirmLabel:string):Promise<boolean>{
  if(document.querySelector('dialog[data-action-confirm]'))return Promise.resolve(false);
  const trigger=document.activeElement instanceof HTMLElement?document.activeElement:null;
  const dialog=document.createElement('dialog');
  dialog.className='space-delete-dialog';
  dialog.dataset.actionConfirm='';
  dialog.setAttribute('aria-label',title);
  dialog.setAttribute('aria-describedby','action-confirm-message');
  dialog.innerHTML='<h2></h2><p id="action-confirm-message"></p><form method="dialog"><button class="back-btn" value="keep" autofocus></button><button class="head-btn" value="confirm"></button></form>';
  dialog.querySelector('h2')!.textContent=title;
  dialog.querySelector('p')!.textContent=message;
  const keep=dialog.querySelector<HTMLButtonElement>('[value=keep]')!;
  keep.textContent=keepLabel;
  dialog.querySelector('[value=confirm]')!.textContent=confirmLabel;
  document.body.append(dialog);
  return new Promise(resolve=>{
    const cancel=()=>dialog.close('keep');
    document.addEventListener('geekdash-identity-changed',cancel);
    dialog.onsubmit=event=>{event.preventDefault();dialog.close((event.submitter as HTMLButtonElement|null)?.value??'keep');};
    dialog.oncancel=event=>{event.preventDefault();cancel();};
    dialog.onclose=()=>{
      const confirmed=dialog.returnValue==='confirm';
      document.removeEventListener('geekdash-identity-changed',cancel);
      dialog.remove();
      if(trigger?.isConnected)trigger.focus({preventScroll:true});
      resolve(confirmed);
    };
    dialog.showModal();
    keep.focus({preventScroll:true});
  });
}
