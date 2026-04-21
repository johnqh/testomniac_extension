import type {
  DomSnapshotEntry,
  ExtractorCandidate,
  ItemExtractor,
} from './types';
import { createCandidate, uniqueBySelector } from './helpers';

function isTextInput(entry: DomSnapshotEntry): boolean {
  const tag = entry.tagName.toUpperCase();
  const role = (entry.role || '').toLowerCase();
  const inputType = (entry.inputType || '').toLowerCase();

  if (role === 'textbox') return true;
  if (entry.sourceHints.includes('contenteditable')) return true;
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;

  return ![
    'hidden',
    'checkbox',
    'radio',
    'submit',
    'button',
    'reset',
    'file',
    'image',
    'range',
    'color',
  ].includes(inputType);
}

export const textInputExtractor: ItemExtractor = {
  name: 'text-inputs',
  extract(entries: DomSnapshotEntry[]): ExtractorCandidate[] {
    return uniqueBySelector(
      entries
        .filter(isTextInput)
        .map(entry => createCandidate(entry, 'text-inputs'))
    );
  },
};
