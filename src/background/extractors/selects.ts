import type {
  DomSnapshotEntry,
  ExtractorCandidate,
  ItemExtractor,
} from './types';
import { createCandidate, uniqueBySelector } from './helpers';

function isSelect(entry: DomSnapshotEntry): boolean {
  const tag = entry.tagName.toUpperCase();
  const role = (entry.role || '').toLowerCase();
  return tag === 'SELECT' || role === 'combobox' || role === 'option';
}

export const selectExtractor: ItemExtractor = {
  name: 'selects',
  extract(entries: DomSnapshotEntry[]): ExtractorCandidate[] {
    return uniqueBySelector(
      entries.filter(isSelect).map(entry => createCandidate(entry, 'selects'))
    );
  },
};
