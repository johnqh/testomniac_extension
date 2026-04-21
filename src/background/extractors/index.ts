import type { ActionableItem } from '@sudobility/testomniac_types';
import type { ChromeAdapter } from '../../adapters/ChromeAdapter';
import { buildDomSnapshot } from './domSnapshot';
import { buttonExtractor } from './buttons';
import { clickableExtractor } from './clickables';
import { productActionExtractor } from './productActions';
import { resolveSelectors } from './selectors';
import { selectExtractor } from './selects';
import { textInputExtractor } from './textInputs';
import { toggleExtractor } from './toggles';
import type { ItemExtractor } from './types';

const extractorRegistry: ItemExtractor[] = [
  textInputExtractor,
  selectExtractor,
  toggleExtractor,
  productActionExtractor,
  buttonExtractor,
  clickableExtractor,
];

export async function extractActionableItems(
  adapter: ChromeAdapter
): Promise<ActionableItem[]> {
  const snapshot = await buildDomSnapshot(adapter);
  const candidates = extractorRegistry.flatMap(extractor =>
    extractor.extract(snapshot)
  );
  return resolveSelectors(candidates);
}

export function getRegisteredExtractorNames(): string[] {
  return extractorRegistry.map(extractor => extractor.name);
}
