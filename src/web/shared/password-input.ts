export function setupPasswordInputs(){
 document.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(input=>{
  const wrapper=document.createElement('div');wrapper.className='password-input';input.before(wrapper);wrapper.append(input);
  const button=document.createElement('button');button.type='button';button.className='password-toggle';button.textContent='显示';button.setAttribute('aria-label','显示密码');button.setAttribute('aria-pressed','false');
  button.onclick=()=>{const show=input.type==='password';input.type=show?'text':'password';button.textContent=show?'隐藏':'显示';button.setAttribute('aria-label',show?'隐藏密码':'显示密码');button.setAttribute('aria-pressed',String(show));};wrapper.append(button);
 });
}
