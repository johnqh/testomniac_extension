import type { ActionableItem } from '@sudobility/testomniac_types';
import type { ExtractorCandidate, SelectorResolvedCandidate } from './types';
import { uniqueBySelector, withResolvedSelector } from './helpers';

function classifyActionKind(
  candidate: ExtractorCandidate
): ActionableItem['actionKind'] {
  const tag = candidate.tagName.toUpperCase();
  const role = (candidate.role || '').toLowerCase();
  const inputType = (candidate.inputType || '').toLowerCase();

  if (tag === 'A' && candidate.href) return 'navigate';
  if (tag === 'SELECT' || role === 'combobox' || role === 'option')
    return 'select';
  if (role === 'textbox') return 'fill';
  if (tag === 'TEXTAREA') return 'fill';
  if (
    tag === 'INPUT' &&
    ![
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
    ].includes(inputType)
  ) {
    return 'fill';
  }
  if (['checkbox', 'radio', 'switch'].includes(role)) return 'toggle';
  if (['checkbox', 'radio'].includes(inputType)) return 'toggle';
  return 'click';
}

export function resolveSelectors(
  candidates: ExtractorCandidate[]
): SelectorResolvedCandidate[] {
  return uniqueBySelector(candidates).map(candidate =>
    withResolvedSelector(candidate, classifyActionKind(candidate))
  );
}
