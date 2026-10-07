import type { Page } from "playwright";

/**
 * Fields whose contents must never appear in screenshots: passwords, payment data, one-time
 * codes and anything explicitly marked sensitive. Playwright paints these with a solid box.
 */
export const SENSITIVE_FIELD_SELECTORS = [
  'input[type="password"]',
  'input[autocomplete^="cc-"]',
  'input[autocomplete="one-time-code"]',
  'input[name*="card" i]',
  'input[name*="cvv" i]',
  'input[name*="cvc" i]',
  'input[name*="iban" i]',
  'input[name*="ssn" i]',
  'input[name*="token" i]',
  'input[name*="secret" i]',
  "[data-sensitive]",
  'iframe[src*="stripe" i]',
  'iframe[src*="braintree" i]',
];

export function sensitiveMask(page: Page) {
  return SENSITIVE_FIELD_SELECTORS.map((s) => page.locator(s));
}
