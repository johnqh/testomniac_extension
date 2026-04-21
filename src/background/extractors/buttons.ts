import type {
  DomSnapshotEntry,
  ExtractorCandidate,
  ItemExtractor,
} from './types';
import { createCandidate, uniqueBySelector } from './helpers';

function isButton(entry: DomSnapshotEntry): boolean {
  const tag = entry.tagName.toUpperCase();
  const role = (entry.role || '').toLowerCase();
  const inputType = (entry.inputType || '').toLowerCase();
  const text =
    `${entry.accessibleName || ''} ${entry.textContent || ''}`.toLowerCase();

  if (tag === 'BUTTON') return true;
  if (tag === 'SUMMARY') return true;
  if (['button', 'tab', 'menuitem'].includes(role)) return true;
  if (
    tag === 'INPUT' &&
    ['submit', 'button', 'reset', 'image', 'file'].includes(inputType)
  ) {
    return true;
  }

  return (
    text.includes('submit') ||
    text.includes('save') ||
    text.includes('search') ||
    text.includes('add to cart') ||
    text.includes('checkout') ||
    text.includes('select options')
  );
}

export const buttonExtractor: ItemExtractor = {
  name: 'buttons',
  extract(entries: DomSnapshotEntry[]): ExtractorCandidate[] {
    return uniqueBySelector(
      entries.filter(isButton).map(entry => createCandidate(entry, 'buttons'))
    );
  },
};
