// Tax payments by kind and jurisdiction (plan Revision 6, R6-2). Ingest stores two kinds of rows in
// tax_payments: 'withholding' (from W-2s, paystubs and 1099s, one row per document and
// jurisdiction) and 'paid' (estimated payments from the payment workbook). Each counts once, in
// its own figure. Pure: everything comes from loadPlanningData.
//
// jurisdictionOf(value) -> 'federal' | 'virginia' | 'unknown-state' | 'other-state'
// classifyPayments(data, {persons, f, isVa}) -> {fed: {paid, withheld}, va: {paid, withheld},
//   lastPaidDate, lastWithheldDate, warnings}; each figure is {rows, ids, total, blocked}

import { cents } from '../../store/db.mjs';

export function jurisdictionOf(value) {
  const j = String(value ?? '').trim().toLowerCase();
  if (j === 'federal') return 'federal';
  if (j === 'va' || j === 'virginia') return 'virginia';
  if (j === 'state') return 'unknown-state';
  return 'other-state';
}

// wh:<employer or payer key>:<year>:<jurisdiction>:<recipient>
const slotKey = row => {
  const parts = String(row.source_slot ?? '').split(':');
  return parts[0] === 'wh' ? `${parts[1]}:${parts[2]}` : null;
};
const formOf = row => String(row.payer ?? '').split(':')[0];

export function classifyPayments(data, { persons, f, isVa }) {
  const figure = () => ({ rows: [], ids: [], total: 0, blocked: null });
  const out = { fed: { paid: figure(), withheld: figure() }, va: { paid: figure(), withheld: figure() }, lastPaidDate: null, lastWithheldDate: null, warnings: [] };
  const block = (fig, code) => { if (fig && !fig.blocked) fig.blocked = code; };
  const add = (fig, row) => { fig.rows.push(row); };
  const mfj = f === 'mfj';

  // Rows a pending withholding_conflict names: neither may count until it is answered.
  const conflicted = new Set();
  for (const i of data.confirm || []) {
    if (i.kind !== 'withholding_conflict' || i.status !== 'pending') continue;
    for (const ref of [i.context && i.context.first, i.context && i.context.second]) if (ref && ref.id != null) conflicted.add(ref.id);
  }
  // Employer slots holding both a W-2 row and a paystub row: unresolved rows there would double
  // count, because ingest summarizes paystubs only once the recipient is known.
  const forms = new Map();
  for (const r of data.taxPayments) {
    const k = slotKey(r);
    if (!k) continue;
    if (!forms.has(k)) forms.set(k, new Set());
    forms.get(k).add(formOf(r));
  }
  const mixed = r => { const s = forms.get(slotKey(r)); return !!s && s.has('w2') && s.has('paystub'); };

  const bucketOf = row => {
    const j = jurisdictionOf(row.jurisdiction);
    if (j === 'federal') return { j, b: out.fed };
    if (j === 'virginia' || j === 'unknown-state') return { j, b: out.va };
    return { j, b: null };
  };

  for (const r of data.taxPayments) {
    const { j, b } = bucketOf(r);
    if (r.kind !== 'paid' && r.kind !== 'withholding') {
      if (b) { block(b.paid, 'tax_payment_kind_unknown'); block(b.withheld, 'tax_payment_kind_unknown'); }
      continue;
    }
    if (r.kind === 'paid') {
      // Workbook groups are only federal or state; a state payment is Virginia's for a Virginia household.
      if (!b || (j === 'unknown-state' && !isVa)) continue;
      if (r.tax_year_basis === 'sheet_label') block(b.paid, 'tax_year_unconfirmed');
      add(b.paid, r);
      continue;
    }
    if (j === 'other-state') { out.warnings.push('other_state_withholding'); continue; }
    if (j === 'unknown-state') { block(b.withheld, 'withholding_state_unknown'); continue; }
    if (conflicted.has(r.id)) block(b.withheld, 'withholding_conflict_pending');
    if (persons.includes(r.recipient)) { add(b.withheld, r); continue; }
    if (r.recipient === 'unknown' || r.recipient == null) {
      if (!mfj || mixed(r)) { block(b.withheld, 'withholding_recipient_unknown'); continue; }
      add(b.withheld, r);
    }
    // A recipient outside the filing unit is not this return's withholding.
  }
  // Next year's sheet rows whose year is unconfirmed may belong to this year (January estimates).
  for (const r of data.taxPaymentsNext || []) {
    if (r.kind !== 'paid' || r.tax_year_basis !== 'sheet_label') continue;
    const { j, b } = bucketOf(r);
    if (b && !(j === 'unknown-state' && !isVa)) block(b.paid, 'tax_year_unconfirmed');
  }

  for (const b of [out.fed, out.va]) {
    if (!mfj && new Set(b.paid.rows.map(r => String(r.payer ?? '').trim().toLowerCase())).size > 1) block(b.paid, 'estimated_payer_unknown');
    for (const fig of [b.paid, b.withheld]) {
      fig.rows.sort((x, y) => x.id - y.id);
      fig.ids = fig.rows.map(r => r.id);
      fig.total = cents(fig.rows.reduce((s, r) => s + Number(r.amount), 0));
    }
  }
  const latest = rows => rows.map(r => r.date).filter(Boolean).sort().at(-1) || null;
  out.lastPaidDate = latest([...out.fed.paid.rows, ...out.va.paid.rows]);
  out.lastWithheldDate = latest([...out.fed.withheld.rows, ...out.va.withheld.rows]);
  out.warnings = [...new Set(out.warnings)];
  return out;
}
