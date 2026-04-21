import type { ActionableItem } from '@sudobility/testomniac_types';

export type ActionKind = ActionableItem['actionKind'];

export interface ExtractorCandidate extends Omit<
  ActionableItem,
  'stableKey' | 'actionKind'
> {
  source: string;
}

export interface SelectorResolvedCandidate extends ExtractorCandidate {
  stableKey: string;
  actionKind: ActionKind;
}

export interface DomSnapshotEntry {
  selector: string;
  tagName: string;
  role?: string;
  inputType?: string;
  accessibleName?: string;
  textContent?: string;
  href?: string;
  disabled: boolean;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  attributes: Record<string, string>;
  sourceHints: string[];
}

export interface ItemExtractor {
  name: string;
  extract(entries: DomSnapshotEntry[]): ExtractorCandidate[];
}
