import type {
  DomSnapshotEntry,
  ExtractorCandidate,
  ItemExtractor,
} from './types';
import { createCandidate, uniqueBySelector } from './helpers';

function looksLikeProductAction(entry: DomSnapshotEntry): boolean {
  const href = (entry.href || '').toLowerCase();
  const text =
    `${entry.accessibleName || ''} ${entry.textContent || ''}`.toLowerCase();

  if (href.includes('/store/')) return true;
  if (href.includes('ec_action=addtocart')) return true;
  if (href.includes('/my-cart/')) return true;

  return (
    text.includes('add to cart') ||
    text.includes('checkout now') ||
    text.includes('select options')
  );
}

export const productActionExtractor: ItemExtractor = {
  name: 'product-actions',
  extract(entries: DomSnapshotEntry[]): ExtractorCandidate[] {
    return uniqueBySelector(
      entries
        .filter(looksLikeProductAction)
        .map(entry => createCandidate(entry, 'product-actions'))
    );
  },
};
