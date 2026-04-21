import type { ActionableItem } from '@sudobility/testomniac_types';

export interface FillValuePlanner {
  planValue(item: ActionableItem): string;
}

export class RuleBasedFillValuePlanner implements FillValuePlanner {
  planValue(item: ActionableItem): string {
    const text =
      `${item.accessibleName || ''} ${item.textContent || ''}`.toLowerCase();
    const inputType = (item.inputType || '').toLowerCase();

    if (inputType === 'email' || text.includes('email')) {
      return 'testomniac@example.com';
    }
    if (inputType === 'tel' || text.includes('phone')) {
      return '5550101234';
    }
    if (
      inputType === 'url' ||
      text.includes('website') ||
      text.includes('url')
    ) {
      return 'https://example.com';
    }
    if (inputType === 'number') {
      return '1';
    }
    if (inputType === 'date') {
      return '2026-01-21';
    }
    if (inputType === 'time') {
      return '09:00';
    }
    if (text.includes('name')) {
      return 'Testomniac User';
    }
    if (text.includes('title') || text.includes('subject')) {
      return 'Automated bug report';
    }
    if (
      text.includes('description') ||
      text.includes('details') ||
      text.includes('steps') ||
      text.includes('expected') ||
      text.includes('actual') ||
      text.includes('comment') ||
      text.includes('message')
    ) {
      return 'Automated test input from Testomniac.';
    }
    return 'Test input';
  }
}

export const fillValuePlanner = new RuleBasedFillValuePlanner();
