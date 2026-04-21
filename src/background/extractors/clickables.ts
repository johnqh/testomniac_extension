import type {
  DomSnapshotEntry,
  ExtractorCandidate,
  ItemExtractor,
} from './types';
import { createCandidate, uniqueBySelector } from './helpers';

function isGenericClickable(entry: DomSnapshotEntry): boolean {
  const tag = entry.tagName.toUpperCase();
  const role = (entry.role || '').toLowerCase();
  if (tag === 'A' && entry.href) return true;
  if (role === 'link') return true;
  if (entry.sourceHints.includes('mouse-handler')) return true;

  return (
    entry.sourceHints.includes('anchor') ||
    entry.sourceHints.includes('button') ||
    entry.sourceHints.includes('summary')
  );
}

export const clickableExtractor: ItemExtractor = {
  name: 'clickables',
  extract(entries: DomSnapshotEntry[]): ExtractorCandidate[] {
    return uniqueBySelector(
      entries
        .filter(isGenericClickable)
        .map(entry => createCandidate(entry, 'clickables'))
    );
  },
};
