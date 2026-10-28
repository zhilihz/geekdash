import './shared/board.css';
import './shared/read.css';
import './shared/design.css';
import { get,requireIdentity,setupTheme } from './shared/api';
setupTheme();
void requireIdentity().then(async()=>{
 const profile=await get<{loginName:string;name:string}>('/api/profile');
 (document.getElementById('profile-login') as HTMLInputElement).value=profile.loginName;
 (document.getElementById('profile-name') as HTMLInputElement).value=profile.name;
}).catch(error=>{document.getElementById('profile-message')!.textContent=(error as Error).message;});
