// merchantDisplayName turns a raw bank description into the name a person would say, and
// plainEvidence keeps machine-provenance details (vendor names, model ids, percentages) out of the
// evidence text the Confirm screen shows. Every string here is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { merchantDisplayName, plainEvidence } from '../src/categories/display.mjs';

const cases = [
  // ACH and bank-rail prefixes, with the trailing reference id
  ['ACH DEBIT EXAMPLE UTILITY CO 8837261', 'Example Utility Co'],
  ['ACH CREDIT SAMPLE PAYROLL LLC PPD ID: 9120034411', 'Sample Payroll LLC'],
  ['WEB PMT EXAMPLE INSURANCE 20261003', 'Example Insurance'],
  ['RECURRING PAYMENT DEMO STREAMING', 'Demo Streaming'],
  // card-processor prefixes
  ['SQ *SAMPLE COFFEE #0412', 'Sample Coffee'],
  ['TST* DEMO BISTRO', 'Demo Bistro'],
  ['PAYPAL *EXAMPLEMART 402-935-7733', 'Examplemart'],
  ['POS DEBIT DEMO FUEL STOP 00418', 'Demo Fuel Stop'],
  ['CHECKCARD 1015 SAMPLE PHARMACY 4471', 'Sample Pharmacy'],
  ['PURCHASE AUTHORIZED ON 10/12 DEMO HARDWARE S462837291 CARD 1234', 'Demo Hardware'],
  // store numbers
  ['DEMO GROCER #187', 'Demo Grocer'],
  ['DEMO GROCER STORE 0187', 'Demo Grocer'],
  ['Demo Grocer No. 44', 'Demo Grocer'],
  // trailing ids after a star or a long mixed token
  ['AMZN MKTP US*2K4XY91Z0', 'Amzn Mktp US'],
  ['EXAMPLE CLOUD SERVICES AB12CD34EF', 'Example Cloud Services'],
  // casing
  ['demo books', 'Demo Books'],
  ['Example Cloud Services', 'Example Cloud Services'],
  ["SAMPLE JOE'S DELI", "Sample Joe's Deli"],
  ['STREAMBOX.COM', 'Streambox.com'],
  ['DEMO  &  SONS   HARDWARE', 'Demo & Sons Hardware'],
];

for (const [raw, want] of cases) {
  test(`merchantDisplayName(${JSON.stringify(raw)})`, () => {
    assert.equal(merchantDisplayName(raw), want);
  });
}

test('merchantDisplayName is idempotent on its own output', () => {
  for (const [raw] of cases) {
    const once = merchantDisplayName(raw);
    assert.equal(merchantDisplayName(once), once, raw);
  }
});

test('merchantDisplayName returns an empty string for a missing or non-text value', () => {
  for (const v of [undefined, null, '', '   ', 42, {}, []]) assert.equal(merchantDisplayName(v), '', String(v));
});

test('merchantDisplayName never returns an empty name for text that is only noise', () => {
  assert.equal(merchantDisplayName('ACH 123456'), 'Ach 123456');
  assert.equal(merchantDisplayName('#4412'), '#4412');
});

test('plainEvidence passes plain-language evidence through unchanged', () => {
  const text = 'Your last four Groceries purchases at this merchant were all Groceries. The amount is typical.';
  assert.equal(plainEvidence(text), text);
});

test('plainEvidence drops vendor names, model ids and percentages, keeping clean sentences', () => {
  assert.equal(plainEvidence('Jev guess, 99% confident'), '');
  assert.equal(plainEvidence('jev-1.14.0 chose this'), '');
  assert.equal(plainEvidence('Typesafe returned Groceries.'), '');
  assert.equal(plainEvidence('About 90 percent sure.'), '');
  assert.equal(plainEvidence('Same merchant as two past purchases. Scored 87% likely.'), 'Same merchant as two past purchases.');
  assert.equal(plainEvidence(null), '');
  assert.equal(plainEvidence(undefined), '');
});
