export type TaggedMemory = { tags: string[] };

const ignored = new Set('january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun daily weekly monthly yearly annually biweekly fortnightly everyday everyweek misc miscellaneous general generic other unknown important note notes document documents image photo picture text file files mock-ai 未分类 其他 杂项 重要 笔记 文档 图片 照片 文本 文件 每天 每周 每月 每年 周期性 每星期'.split(' '));

export function canonicalTag(raw: string): string | null {
  let value = raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase().replace(/^[,.;:!?，。；：！？#]+|[,.;:!?，。；：！？#]+$/g, '');
  if (!value || value.length > 60 || /^\d{1,4}([-/.]\d{1,2}){0,2}$/.test(value) || ignored.has(value)) return null;
  const aliases: Record<string, string> = { wonders: 'wonder', 'wonder opportunity': 'wonder', 'wonder opportunities': 'wonder', 'hand made': 'handmade', 'market day': 'market', 'market days': 'market' };
  value = aliases[value] || value;
  if (/^[a-z]+$/.test(value) && value.length > 4) {
    if (value.endsWith('ies') && value.length > 5) value = value.slice(0, -3) + 'y';
    else if (value.endsWith('s') && !/(ss|us|is|ws)$/.test(value)) value = value.slice(0, -1);
  }
  return ignored.has(value) ? null : value;
}

export function availableTags(memories: TaggedMemory[]): string[] {
  return [...new Set(memories.flatMap((memory) => displayTags(memory.tags)))].sort((a, b) => a.localeCompare(b));
}

export function displayTags(tags: string[]): string[] {
  return [...new Set(tags.map(canonicalTag).filter((tag): tag is string => !!tag))];
}

// Multiple selections match any selected tag; keyword results are narrowed by this filter.
export function filterByTags<T extends TaggedMemory>(memories: T[], selectedTags: string[]): T[] {
  if (selectedTags.length === 0) return memories;
  const selected = new Set(selectedTags);
  return memories.filter((memory) => memory.tags.some((tag) => { const canonical = canonicalTag(tag); return canonical !== null && selected.has(canonical); }));
}
