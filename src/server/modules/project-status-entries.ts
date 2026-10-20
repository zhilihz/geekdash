export type StatusEntry = { text: string; date: string };
export type StatusChange = { action: string; beforeText: string | null; afterText: string; createdAt: string };
const normalize = (text: string) => text.replace(/\r\n?/g, '\n');

export function projectStatusOwners(text: string, knownNames: string[]): string[] {
  const names = [...new Set(knownNames.filter(Boolean))].sort((a, b) => b.length - a.length);
  const owners = new Set<string>(), mentions = /@/gu;
  for (let mention; (mention = mentions.exec(text));) {
    const tail = text.slice(mention.index + 1);
    const name = names.find(name => tail.startsWith(name) && (tail.length === name.length || /[\s@，,。；;：:！？!?（）()\[\]【】、<>]/u.test(tail[name.length])))
      ?? tail.match(/^([^\s@，,。；;：:！？!?（）()\[\]【】、<>]+)/u)?.[1];
    if (name) { owners.add(name); mentions.lastIndex += name.length; }
  }
  return [...owners];
}

function matchLines(previous: StatusEntry[], text: string, changedAt = ''): StatusEntry[] {
  const dates = new Map<string, string[]>();
  for (const entry of previous) {
    const queue = dates.get(entry.text) ?? [];
    queue.push(entry.date); dates.set(entry.text, queue);
  }
  return normalize(text).split('\n').map(line => {
    const queue = dates.get(line);
    return { text: line, date: line.trim() ? queue?.length ? queue.shift()! : changedAt : '' };
  });
}

// 1054 同文行按出现次序匹配；日期仅来自真实状态变更，不把整段最后更新时间当作每行时间。
export function projectStatusEntries(text: string, changes: StatusChange[]): StatusEntry[] {
  let entries: StatusEntry[] = [];
  for (const change of changes) {
    if (change.action === 'project.create') {
      entries = matchLines([], change.afterText, change.createdAt);
      continue;
    }
    if (change.beforeText === null) {
      entries = matchLines(entries, change.afterText);
      continue;
    }
    // 缺少更早审计时，先恢复无日期的旧正文；有证据的同文行仍保留原日期。
    entries = matchLines(entries, change.beforeText);
    entries = matchLines(entries, change.afterText, change.createdAt);
  }
  // 当前正文始终为准；来源缺失或手工迁移带来的新行不补造日期。
  return matchLines(entries, text);
}
