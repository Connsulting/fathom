// UI3 AC2: transactionDisplayName reads structured bank text (ACH addenda, wire memos, online
// transfers) as what happened, and falls back to merchantDisplayName for anything else. Every
// description, name, number and institution here is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { transactionDisplayName, merchantDisplayName } from '../src/categories/display.mjs';

const CASES = [
  // ACH addenda: the originator and what the entry was for.
  ['ORIG CO NAME:GUSTO ORIG ID:9000000001 DESC DATE:260415 CO ENTRY DESCR:NET SEC:CCD TRACE#:091000010000001 EED:260415 IND ID:SYN123 IND NAME:EXAMPLE CO TRN: 1234567890TC', 'Gusto payroll (net)'],
  ['orig co name:gusto orig id:9000000001 desc date:260415 co entry descr:tax sec:ccd trace#:091000010000002 eed:260415 ind id:syn123 ind name:example co trn: 1234567891tc', 'Gusto payroll tax'],
  ['ORIG CO NAME:ADP PAYROLL ORIG ID:9000000002 DESC DATE:260415 CO ENTRY DESCR:PAYROLL SEC:PPD TRACE#:091000010000003', 'ADP payroll'],
  ['ORIG CO NAME:PAYCHEX ORIG ID:9000000003 CO ENTRY DESCR:DIR DEP SEC:PPD', 'Paychex payroll'],
  ['ORIG CO NAME:INTUIT PAYROLL S ORIG ID:9000000004 CO ENTRY DESCR:NET SEC:CCD', 'Intuit payroll (net)'],
  ['ORIG CO NAME:IRS ORIG ID:9000000005 DESC DATE:260415 CO ENTRY DESCR:USATAXPYMT SEC:CCD TRACE#:1', 'IRS tax payment'],
  ['ORIG CO NAME:STRIPE ORIG ID:9000000006 DESC DATE:260415 CO ENTRY DESCR:TRANSFER SEC:CCD TRACE#:2', 'Stripe transfer'],
  ['ORIG CO NAME:EXAMPLE SHOP ORIG ID:9000000007 CO ENTRY DESCR:PAYOUTS SEC:CCD', 'Example Shop transfer'],
  ['ORIG CO NAME:GUSTO ORIG ID:9000000001 CO ENTRY DESCR:FEE 4455667 SEC:CCD', 'Gusto fee'],
  ['ORIG CO NAME:EXAMPLE SOFTWARE ORIG ID:9000000008 CO ENTRY DESCR:INVOICE SEC:CCD', 'Example Software fee'],
  ['ORIG CO NAME:EXAMPLE UTILITY ORIG ID:9000000009 CO ENTRY DESCR:AUTOPAY SEC:PPD', 'Example Utility autopay'],
  ['ORIG CO NAME:EXAMPLE UTILITY ORIG ID:9000000009 CO ENTRY DESCR:   SEC:PPD', 'Example Utility'],
  // Wires: the beneficiary of an outgoing one, the originator of an incoming one.
  ['ONLINE DOMESTIC WIRE TRANSFER VIA: EXAMPLE BANK NA/021000000 A/C: NATIONAL FINANCIAL SERVICES LLC BOSTON MA 02210 US REF: SYN/TIME/12:00 IMAD: 0415MMQFMP2N000001 TRN: 3000000001ES', 'Wire to National Financial Services'],
  ['OUTGOING WIRE TRANSFER BNF: SUMMIT EXAMPLE PARTNERS LP DENVER CO 80202 US OBI: INVOICE 7 TRN: 3000000002ES', 'Wire to Summit Example Partners'],
  ['ONLINE INTERNATIONAL WIRE TRANSFER A/C: SAMPLE TRADING LTD LONDON GB REF: 1', 'Wire to Sample Trading'],
  ['FEDWIRE CREDIT VIA: EXAMPLE BANK/021000000 B/O: ACME HOLDINGS INC NEW YORK NY 10001 US REF: SYN/BNF/X IMAD: 0415MMQFMP2N000002 TRN: 3000000003FF', 'Wire from Acme Holdings'],
  ['INCOMING WIRE TRANSFER VIA EXAMPLE BANK ORG: PAT EXAMPLE SPRINGFIELD IL 62701 US OBI: RENT SSN: 0000000', 'Wire from Pat Example'],
  ['WIRE TRANSFER FROM SAMPLE CORP', 'Wire from Sample'],
  ['OUTGOING WIRE TRANSFER REF: 123456', 'Outgoing wire'],
  ['FEDWIRE CREDIT VIA: EXAMPLE BANK/021000000 IMAD: 0415MMQFMP2N000003', 'Incoming wire'],
  // Online transfers between the owner's own accounts.
  ['Online Transfer to CHK ...3554 transaction#: 23000000001 04/15', 'Transfer to checking 3554'],
  ['ONLINE TRANSFER FROM SAV ...1234 TRANSACTION#: 1 04/15', 'Transfer from savings 1234'],
  ['Online Transfer to MMA x9876 transaction#: 2', 'Transfer to money market 9876'],
  ['ONLINE TRANSFER TO SAVINGS XXXXXX4321', 'Transfer to savings 4321'],
  ['Online transfer from BRK #5555', 'Transfer from brokerage 5555'],
  ['Online Transfer to CC ...0007', 'Transfer to card 0007'],
  ['Online Transfer to SAV transaction#: 3 04/15', 'Transfer to savings'],
];

for (const [raw, want] of CASES) {
  test(`transactionDisplayName(${JSON.stringify(raw.slice(0, 60))})`, () => {
    assert.equal(transactionDisplayName(raw), want);
  });
}

test('anything else reads as merchantDisplayName does', () => {
  for (const raw of ['SQ *SAMPLE COFFEE #0412', 'ACH DEBIT EXAMPLE UTILITY CO PPD ID: 1234567890', 'Client payment', 'DOMESTIC WIRE FEE', 'Bank fee', 'POS PURCHASE EXAMPLE MARKET 04/12']) {
    assert.equal(transactionDisplayName(raw), merchantDisplayName(raw), raw);
  }
  assert.equal(transactionDisplayName('SQ *SAMPLE COFFEE #0412'), 'Sample Coffee');
});

test('a missing or non-text description is the empty string', () => {
  for (const v of [undefined, null, '', '   ', 42, {}, []]) assert.equal(transactionDisplayName(v), '', String(v));
});

test('a non-empty description never reads as an empty name', () => {
  const odd = ['ORIG CO NAME: ORIG ID:1', 'WIRE', 'FEDWIRE CREDIT B/O: 021000000', 'Online Transfer to ...1234', 'ACH 123456', '#', '...', 'A/C:', 'x'];
  for (const raw of [...CASES.map(([r]) => r), ...odd]) {
    const name = transactionDisplayName(raw);
    assert.equal(typeof name, 'string');
    assert.ok(name.trim().length > 0, `${JSON.stringify(raw)} -> ${JSON.stringify(name)}`);
  }
});

test('the name is deterministic', () => {
  for (const [raw] of CASES) assert.equal(transactionDisplayName(raw), transactionDisplayName(raw));
});
