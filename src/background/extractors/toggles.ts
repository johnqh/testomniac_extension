import type {
  DomSnapshotEntry,
  ExtractorCandidate,
  ItemExtractor,
} from './types';
import { createCandidate, uniqueBySelector } from './helpers';

function isToggle(entry: DomSnapshotEntry): boolean {
  const role = (entry.role || '').toLowerCase();
  const inputType = (entry.inputType || '').toLowerCase();
  return (
    ['checkbox', 'radio'].includes(inputType) ||
    ['checkbox', 'radio', 'switch'].includes(role)
  );
}

export const toggleExtractor: ItemExtractor = {
  name: 'toggles',
  extract(entries: DomSnapshotEntry[]): ExtractorCandidate[] {
    return uniqueBySelector(
      entries.filter(isToggle).map(entry => createCandidate(entry, 'toggles'))
    );
  },
};
