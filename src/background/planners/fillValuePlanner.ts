import type { ActionableItem } from '@sudobility/testomniac_types';

export interface FillValuePlanner {
  planValue(item: ActionableItem): string;
}

/**
 * Gather all text signals from the item for field-type inference.
 * Combines: inputType, accessibleName, textContent, placeholder,
 * name attribute, id attribute, autocomplete hint, and label text.
 */
function gatherSignals(item: ActionableItem): string {
  const parts: string[] = [];
  if (item.inputType) parts.push(item.inputType);
  if (item.accessibleName) parts.push(item.accessibleName);
  if (item.textContent) parts.push(item.textContent);

  const attrs = (item.attributes || {}) as Record<string, string>;
  if (attrs.placeholder) parts.push(attrs.placeholder);
  if (attrs.name) parts.push(attrs.name);
  if (attrs.id) parts.push(attrs.id);
  if (attrs.autocomplete) parts.push(attrs.autocomplete);
  if (attrs.labelText) parts.push(attrs.labelText);

  return parts.join(' ').toLowerCase();
}

/** Check if signal text matches any of the given keywords. */
function matches(signal: string, ...keywords: string[]): boolean {
  return keywords.some(k => signal.includes(k));
}

// Realistic test data for each field type
const TEST_VALUES: Record<string, string> = {
  email: 'jane.tester@example.com',
  password: 'T3st!Pass#2026',
  phone: '(555) 012-3456',
  firstName: 'Jane',
  lastName: 'Tester',
  fullName: 'Jane Tester',
  username: 'jane.tester',
  street: '742 Evergreen Terrace',
  address2: 'Apt 4B',
  city: 'Springfield',
  state: 'IL',
  zip: '62704',
  country: 'United States',
  url: 'https://example.com',
  company: 'Acme Testing Co.',
  title: 'QA Engineer',
  date: '2026-01-21',
  time: '09:30',
  number: '3',
  creditCard: '4111111111111111',
  cvv: '123',
  expiry: '12/28',
  search: 'blue shirt',
  comment: 'This is a test comment for automated UI testing.',
  message: 'Hello, this is an automated test message from Testomniac.',
  generic: 'Test input',
};

export class RuleBasedFillValuePlanner implements FillValuePlanner {
  planValue(item: ActionableItem): string {
    const signal = gatherSignals(item);
    const inputType = (item.inputType || '').toLowerCase();
    const autocomplete = (
      (item.attributes as Record<string, string>)?.autocomplete || ''
    ).toLowerCase();

    // ── HTML input type takes highest priority ──
    if (inputType === 'email') return TEST_VALUES.email;
    if (inputType === 'password') return TEST_VALUES.password;
    if (inputType === 'tel') return TEST_VALUES.phone;
    if (inputType === 'url') return TEST_VALUES.url;
    if (inputType === 'date') return TEST_VALUES.date;
    if (inputType === 'time') return TEST_VALUES.time;
    if (inputType === 'number') return TEST_VALUES.number;
    if (inputType === 'search') return TEST_VALUES.search;

    // ── Autocomplete attribute (very reliable) ──
    if (autocomplete === 'email') return TEST_VALUES.email;
    if (autocomplete === 'tel' || autocomplete === 'tel-national')
      return TEST_VALUES.phone;
    if (autocomplete === 'given-name') return TEST_VALUES.firstName;
    if (autocomplete === 'family-name') return TEST_VALUES.lastName;
    if (autocomplete === 'name') return TEST_VALUES.fullName;
    if (autocomplete === 'username') return TEST_VALUES.username;
    if (autocomplete === 'new-password' || autocomplete === 'current-password')
      return TEST_VALUES.password;
    if (autocomplete === 'street-address' || autocomplete === 'address-line1')
      return TEST_VALUES.street;
    if (autocomplete === 'address-line2') return TEST_VALUES.address2;
    if (autocomplete === 'address-level2') return TEST_VALUES.city;
    if (autocomplete === 'address-level1') return TEST_VALUES.state;
    if (autocomplete === 'postal-code') return TEST_VALUES.zip;
    if (autocomplete === 'country-name' || autocomplete === 'country')
      return TEST_VALUES.country;
    if (autocomplete === 'organization') return TEST_VALUES.company;
    if (autocomplete === 'cc-number') return TEST_VALUES.creditCard;
    if (autocomplete === 'cc-csc') return TEST_VALUES.cvv;
    if (autocomplete === 'cc-exp') return TEST_VALUES.expiry;
    if (autocomplete === 'url') return TEST_VALUES.url;

    // ── Keyword matching on combined signals ──

    // Email
    if (matches(signal, 'email', 'e-mail', 'correo')) return TEST_VALUES.email;

    // Password
    if (matches(signal, 'password', 'passwd', 'contraseña', 'mot de passe'))
      return TEST_VALUES.password;

    // Phone
    if (matches(signal, 'phone', 'mobile', 'cell', 'tel', 'fax', 'teléfono'))
      return TEST_VALUES.phone;

    // Name variants (check specific before generic)
    if (
      matches(
        signal,
        'first name',
        'first_name',
        'firstname',
        'given name',
        'given_name',
        'prenom',
        'vorname'
      )
    )
      return TEST_VALUES.firstName;
    if (
      matches(
        signal,
        'last name',
        'last_name',
        'lastname',
        'family name',
        'family_name',
        'surname',
        'nachname'
      )
    )
      return TEST_VALUES.lastName;
    if (
      matches(signal, 'username', 'user name', 'user_name', 'login', 'handle')
    )
      return TEST_VALUES.username;
    if (matches(signal, 'full name', 'full_name', 'fullname', 'your name'))
      return TEST_VALUES.fullName;
    // Generic "name" — but not "username" (already handled above)
    if (
      matches(signal, 'name') &&
      !matches(signal, 'user', 'company', 'product', 'file')
    )
      return TEST_VALUES.fullName;

    // Address
    if (
      matches(
        signal,
        'street',
        'address line 1',
        'address1',
        'address_1',
        'address_line1',
        'dirección'
      )
    )
      return TEST_VALUES.street;
    if (
      matches(
        signal,
        'address line 2',
        'address2',
        'address_2',
        'apt',
        'suite',
        'unit'
      )
    )
      return TEST_VALUES.address2;
    if (matches(signal, 'city', 'ciudad', 'town', 'locality'))
      return TEST_VALUES.city;
    if (matches(signal, 'state', 'province', 'region', 'estado'))
      return TEST_VALUES.state;
    if (
      matches(signal, 'zip', 'postal', 'postcode', 'zip code', 'zipcode', 'plz')
    )
      return TEST_VALUES.zip;
    if (matches(signal, 'country', 'país', 'land')) return TEST_VALUES.country;

    // Company / organization
    if (
      matches(
        signal,
        'company',
        'organization',
        'organisation',
        'business',
        'empresa'
      )
    )
      return TEST_VALUES.company;

    // URL / website
    if (matches(signal, 'website', 'url', 'homepage', 'sitio web'))
      return TEST_VALUES.url;

    // Credit card
    if (
      matches(
        signal,
        'card number',
        'card_number',
        'cardnumber',
        'cc-number',
        'credit card'
      )
    )
      return TEST_VALUES.creditCard;
    if (matches(signal, 'cvv', 'cvc', 'security code', 'card code'))
      return TEST_VALUES.cvv;
    if (matches(signal, 'expir', 'exp date', 'exp_date', 'valid until'))
      return TEST_VALUES.expiry;

    // Search
    if (matches(signal, 'search', 'query', 'buscar', 'recherche', 'find'))
      return TEST_VALUES.search;

    // Title / subject
    if (matches(signal, 'title', 'subject', 'topic', 'asunto', 'betreff'))
      return TEST_VALUES.title;

    // Long-text fields
    if (
      matches(
        signal,
        'comment',
        'message',
        'description',
        'details',
        'feedback',
        'note',
        'bio',
        'about',
        'summary',
        'body',
        'content',
        'text',
        'review',
        'reason',
        'steps',
        'expected',
        'actual',
        'remarks'
      )
    ) {
      return item.tagName === 'TEXTAREA'
        ? TEST_VALUES.comment
        : TEST_VALUES.message;
    }

    // Textarea without specific hints → comment
    if (item.tagName === 'TEXTAREA') return TEST_VALUES.comment;

    // Generic address field (catch-all after specific fields)
    if (matches(signal, 'address') && !matches(signal, 'email', 'ip'))
      return TEST_VALUES.street;

    return TEST_VALUES.generic;
  }
}

export const fillValuePlanner = new RuleBasedFillValuePlanner();
