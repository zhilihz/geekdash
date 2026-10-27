const workPages = new Set(['/', '/index.html', '/GeekDash.html', '/project-detail.html', '/project-new.html', '/project-checks.html', '/project-status-summary.html', '/data-manage.html', '/settings.html', '/imports.html', '/profile.html', '/password.html', '/accounts.html', '/project-space.html']);
const workKeys = new Set(['view', 'search', 'page', 'layout', 'customer', 'productLine', 'odmFactory', 'app', 'status', 'priority', 'signal', 'stage', 'progress', 'chip', 'tags', 'group', 'owner', 'deadline', 'checkToday', 'checkCycle', 'id', 'ids', 'quick', 'tab']);

export function workTarget(value: string | null, origin = location.origin, nested = false): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password || !workPages.has(url.pathname)) return;
    const query = new URLSearchParams();
    for (const [key, item] of url.searchParams) {
      if (workKeys.has(key)) query.append(key, item);
      else if (key === 'returnTo' && !nested) { const target = workTarget(item, origin, true); if (target) query.set(key, target); }
    }
    return url.pathname + (query.size ? '?' + query : '');
  } catch { return; }
}

export function loginTarget(target: string, actor?: string, change = false): string {
  const query = new URLSearchParams();
  const allowed = workTarget(target);
  if (allowed) query.set('returnTo', allowed);
  if (actor && /^[1-9][0-9]{0,19}$/.test(actor)) query.set('returnAccount', actor);
  return (change ? '/password.html' : '/login.html') + (query.size ? '?' + query : '');
}

export function afterLogin(actor: string, query = new URLSearchParams(location.search)): string {
  const owner = query.get('returnAccount');
  if (owner && owner !== actor) return '/';
  return workTarget(query.get('returnTo')) ?? '/';
}

// 退出和改密是明确动作，不能被普通登录的返回地址改写。
export function accountLinkTarget(href:string,currentTarget:string,actor?:string,origin=location.origin):string|undefined {
  const url=new URL(href,origin);
  if(url.origin!==origin||url.pathname!=='/login.html')return;
  if(url.searchParams.get('logout')==='1')return '/login.html?logout=1';
  const target=workTarget(url.searchParams.get('returnTo'),origin)??currentTarget;
  return loginTarget(target,url.searchParams.get('returnAccount')??actor,url.searchParams.get('change')==='1');
}
