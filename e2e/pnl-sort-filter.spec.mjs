// P&L sort, filter, rows dialog and month scope (#/pnl/<state>, #/pnlrows/<spec>). The table sorts
// by category, any month and the total from its headers and filters by text, type and empty rows,
// all kept in the hash; a category name or a month cell opens its rows in a dialog whose total is
// the cell; a selected month bounds the rows and the Ask references. Every expected value is read
// from the API inside the test; nothing is hard-coded from the demo, because other specs mutate the
// shared demo store.
// Tags: @pnl2-ac1 sort and filter, @pnl2-ac2 rows dialog, @pnl2-ac3 month scope, @pnl2-ac5 the
// end-to-end path at desktop and phone width (@mobile runs it at 390px too).

import { test, expect, resetDemo, gotoRoute, expectH1, recDialog } from './helpers.mjs';

const r2 = (x) => Math.round(x * 100) / 100;
const attr = (s) => String(s).replace(/["\\]/g, '\\$&');
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
// The page's range label: 'Jan 2032', 'Jan to Jun 2032' or 'Nov 2031 to Oct 2032'.
function spanLabel(from, to) {
  if (from === to) return monthLabel(from);
  if (from.slice(0, 4) === to.slice(0, 4)) return `${MON[Number(from.slice(5, 7)) - 1]} to ${monthLabel(to)}`;
  return `${monthLabel(from)} to ${monthLabel(to)}`;
}

async function getJson(request, path) {
  const res = await request.get(path);
  expect(res.status(), `GET ${path}`).toBe(200);
  return res.json();
}

// The value the page registered for the figure a selector shows.
async function shownValue(locator) {
  const key = await locator.getAttribute('data-fig');
  expect(key, 'the figure carries its key').toBeTruthy();
  return locator.page().evaluate((k) => {
    const f = window.Fathom.api.fig(k);
    return f && !f.missing ? Math.round(f.v * 100) / 100 : null;
  }, key);
}

async function openPnl(page) {
  await gotoRoute(page, 'pnl');
  await expectH1(page, 'P&L');
  await expect(page.locator('[data-pl-table]')).toBeVisible();
}

/* ---------- table model from the API ---------- */

const figV = (api, key) => (key && api.figures[key] ? r2(api.figures[key].v) : null);
// A category's value under a sort key, as the page sorts it (null for a missing figure).
function valueOf(api, section, c, key) {
  if (key === 'tot') return figV(api, c.total);
  if (key.startsWith('m:')) return figV(api, c.months?.[key.slice(2)]);
  if (key === 'ly') return figV(api, api.pnl.prior?.categories?.[section]?.[c.category]);
  if (key === 'avg') return figV(api, c.average);
  return null;
}
// The category order a header sort gives one group: cat by localeCompare, numeric keys by value with
// null as 0 and ties by name ascending in both directions.
function expectedOrder(api, section, cats, s, d) {
  const list = [...cats];
  if (s === 'cat') {
    list.sort((a, b) => a.category.localeCompare(b.category));
    if (d === 'descending') list.reverse();
  } else {
    const sign = d === 'descending' ? -1 : 1;
    list.sort((a, b) => sign * ((valueOf(api, section, a, s) ?? 0) - (valueOf(api, section, b, s) ?? 0)) || a.category.localeCompare(b.category));
  }
  return list.map((c) => c.category);
}

const rowSel = (section) => `[data-pl-table] tr[data-pl-row][data-pl-section="${section}"]`;
const catRow = (page, section, category) => page.locator(`${rowSel(section)}[data-pl-cat-row="${attr(category)}"]`);
// The category rows of a group the owner can see, top to bottom.
const shownCats = (page, sel) => page.locator(sel).evaluateAll((els) => els
  .filter((e) => e.getClientRects().length > 0)
  .map((e) => e.getAttribute('data-pl-cat-row')));

const sortTh = (page, key) => page.locator(`[data-pl-table] th[data-pl-col="${attr(key)}"]`);
async function clickSort(page, key) {
  await sortTh(page, key).locator(`button[data-pl-sort="${attr(key)}"]`).click();
}
// The sorted header carries aria-sort; every other sortable header says none.
async function expectSort(page, key, dir) {
  await expect(sortTh(page, key)).toHaveAttribute('aria-sort', dir);
  const others = await page.locator('[data-pl-table] th[data-pl-col]').evaluateAll((els, k) => els
    .filter((e) => e.getAttribute('data-pl-col') !== k)
    .map((e) => [e.getAttribute('data-pl-col'), e.getAttribute('aria-sort')]), key);
  expect(others.length, 'other sortable headers').toBeGreaterThan(0);
  for (const [col, s] of others) expect(s, `${col} aria-sort`).toBe('none');
}

// The hash state of #/pnl/<state> as URLSearchParams.
const hashState = (page) => page.evaluate(() => location.hash).then((h) => {
  expect(h, 'the P&L route').toMatch(/^#\/pnl(\/|$)/);
  return new URLSearchParams(h.replace(/^#\/pnl\/?/, ''));
});

// Group header and total rows stay at the ends of their group whatever the sort.
async function expectGroupFrame(page) {
  const frames = await page.locator('[data-pl-table] tbody').evaluateAll((bodies) => bodies
    .filter((b) => b.querySelector('tr[data-pl-row]'))
    .map((b) => {
      const trs = [...b.querySelectorAll(':scope > tr')];
      return { first: trs[0].className, last: trs[trs.length - 1].className, rowsWithFrame: b.querySelectorAll('tr.pl-h[data-pl-row], tr.pl-t[data-pl-row]').length };
    }));
  for (const f of frames) {
    expect(f.first).toMatch(/\bpl-h\b/);
    expect(f.last).toMatch(/\bpl-t\b/);
    expect(f.rowsWithFrame).toBe(0);
  }
  await expect(page.locator('[data-pl-table] tbody.pl-net tr[data-pl-row]')).toHaveCount(0);
}

/* ---------- rows dialog ---------- */

const dlgRows = (page) => recDialog(page).locator('table[data-pl-dlg-rows] tr[data-pl-dlg-row]');
const dlgTh = (page, col) => recDialog(page).locator(`table[data-pl-dlg-rows] th[data-pl-dlg-col="${col}"]`);
async function dlgRowData(page) {
  return dlgRows(page).evaluateAll((els) => els.map((e) => ({
    date: e.querySelector('td.pl-d-date time')?.getAttribute('datetime') ?? null,
    desc: (e.querySelector('td.pl-d-desc')?.textContent || '').trim(),
    acct: (e.querySelector('td.pl-d-acct')?.textContent || '').trim(),
    fig: e.querySelector('td.pl-d-amt .fx-fig')?.getAttribute('data-fig') ?? null,
  })));
}

// The dialog lists the rows API's items in its default order (date descending, the API's order),
// each with date, description, account and its amount figure, and a total that is the sum figure.
async function expectDialogRows(page, rows, month) {
  const dlg = recDialog(page);
  await expect(dlg.locator('[data-pl-dlg]')).toBeVisible();
  await expect(dlg.locator('[data-pl-dlg]')).not.toHaveAttribute('aria-busy', 'true');
  await expect(dlgRows(page)).toHaveCount(rows.items.length);
  await expect(dlg.locator('table[data-pl-dlg-rows] th', { hasText: 'Description' })).toHaveCount(1);
  await expect(dlg.locator('table[data-pl-dlg-rows] th', { hasText: 'Account' })).toHaveCount(1);
  await expect(dlgTh(page, 'date').locator('button[data-pl-dlg-sort="date"]')).toBeVisible();
  await expect(dlgTh(page, 'amount').locator('button[data-pl-dlg-sort="amount"]')).toBeVisible();
  await expect(dlgTh(page, 'date')).toHaveAttribute('aria-sort', 'descending');
  await expect(dlgTh(page, 'amount')).toHaveAttribute('aria-sort', 'none');
  const shown = await dlgRowData(page);
  expect(shown.map((r) => r.fig), 'rows in the API order, date descending').toEqual(rows.items.map((i) => i.fig));
  for (const [n, r] of shown.entries()) {
    const it = rows.items[n];
    expect(r.date, `row ${n} date`).toBe(String(it.date));
    if (it.description) expect(r.desc, `row ${n} description`).toContain(it.description);
    expect(r.acct, `row ${n} account`).toContain(it.account);
    if (month) expect(r.date.slice(0, 7), `row ${n} is in ${month}`).toBe(month);
  }
  const total = dlg.locator('[data-pl-dlg-total] .fx-fig');
  await expect(total).toHaveAttribute('data-fig', rows.sum);
  await expect(dlg.locator('[data-pl-dlg-count]')).toContainText(String(rows.total));
  return total;
}

const rowValues = (rows, figs) => figs.map((k) => r2(rows.figures[k].v));

async function closeWithEscape(page) {
  await page.keyboard.press('Escape');
  await expect(recDialog(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/#\/pnlrows\//);
}

// The opener, found again by its spec after the page redraws.
const openerBySpec = (page, spec) => page.locator(`[data-pl-table] button[data-go="pnlrows"][data-id="${attr(spec)}"]`);

// The month in the range with the most cells in a group (the latest on a tie), and the category
// with the most month cells.
function busiestMonth(p, section) {
  let best = p.to, n = -1;
  for (const m of p.months) {
    const k = p[section].categories.filter((c) => c.months?.[m]).length;
    if (k >= n) { best = m; n = k; }
  }
  return best;
}
const busiestCategory = (p, section) => [...p[section].categories]
  .sort((a, b) => Object.values(b.months || {}).filter(Boolean).length - Object.values(a.months || {}).filter(Boolean).length)[0];
const mainSection = (p) => (p.expenses.categories.length >= p.income.categories.length ? 'expenses' : 'income');

test.describe('P&L sort, filter and rows dialog', () => {
  test.beforeEach(async ({ request }) => {
    await resetDemo(request);
  });

  test('@pnl2-ac1 header sorts set aria-sort and reorder every group by the API figures, the hash keeps the sort, and a reload restores it', async ({ page, request }) => {
    const api = await getJson(request, '/api/pnl');
    const p = api.pnl;
    const section = mainSection(p);
    expect(p[section].categories.length, 'a group with more than one category').toBeGreaterThan(1);
    const month = busiestMonth(p, section);
    await openPnl(page);

    // Server order before any sort, every sortable header unsorted.
    for (const s of ['income', 'expenses']) {
      await expect.poll(() => shownCats(page, rowSel(s)), { message: `${s} server order` }).toEqual(p[s].categories.map((c) => c.category));
    }
    const cols = await page.locator('[data-pl-table] th[data-pl-col]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-pl-col'), e.getAttribute('aria-sort')]));
    expect(cols.map(([c]) => c)).toEqual(['cat', ...p.months.map((m) => `m:${m}`), 'tot', ...(p.prior ? ['ly'] : [])]);
    for (const [c, s] of cols) expect(s, `${c} unsorted`).toBe('none');

    const steps = [
      ['cat', 'ascending'], ['cat', 'descending'],
      [`m:${month}`, 'descending'], [`m:${month}`, 'ascending'],
      ['tot', 'descending'], ['tot', 'ascending'],
    ];
    for (const [key, dir] of steps) {
      await clickSort(page, key);
      await expectSort(page, key, dir);
      for (const s of ['income', 'expenses']) {
        await expect.poll(() => shownCats(page, rowSel(s)), { message: `${s} sorted by ${key} ${dir}` })
          .toEqual(expectedOrder(api, s, p[s].categories, key, dir));
      }
      await expectGroupFrame(page);
      const st = await hashState(page);
      expect(st.get('s'), `hash sort key after ${key} ${dir}`).toBe(key);
      expect(st.get('d'), `hash direction after ${key} ${dir}`).toBe(dir === 'ascending' ? 'asc' : 'desc');
    }

    await page.reload();
    await expectH1(page, 'P&L');
    await expectSort(page, 'tot', 'ascending');
    for (const s of ['income', 'expenses']) {
      await expect.poll(() => shownCats(page, rowSel(s)), { message: `${s} after reload` })
        .toEqual(expectedOrder(api, s, p[s].categories, 'tot', 'ascending'));
    }
  });

  test('@pnl2-ac1 the filter row filters by text, type and empty rows, says the totals still count everything, and a reload keeps every filter', async ({ page, request }) => {
    const first = await getJson(request, '/api/pnl');
    // Prefer a P&L whose expenses have a missing month cell, so hiding empty rows hides something.
    let pick = null;
    for (const e of first.entities) {
      const one = await getJson(request, `/api/pnl?${qs({ entity: e.key })}`);
      const m = one.pnl.months.find((mm) => {
        const cats = one.pnl.expenses.categories;
        const empty = cats.filter((c) => !c.months?.[mm] || !figV(one, c.months[mm])).length;
        return empty > 0 && empty < cats.length;
      });
      if (m) { pick = { api: one, month: m }; break; }
    }
    if (!pick) pick = { api: first, month: first.pnl.to };
    const { api, month } = pick;
    const p = api.pnl;
    const key = p.entity.key;
    const names = (s) => p[s].categories.map((c) => c.category);

    await openPnl(page);
    if (key !== first.pnl.entity.key) {
      await page.locator(`[data-pl-views] [data-pl-view="${attr(key)}"]`).click();
      await expect(page.locator(`[data-pl-views] [data-pl-view="${attr(key)}"]`)).toHaveAttribute('aria-pressed', 'true');
    }
    const filters = page.locator('[data-pl-filters]');
    await expect(filters).toBeVisible();
    const input = filters.locator('input[data-pl-filter]');
    await expect(input).toHaveAttribute('type', 'search');
    await expect(input).toHaveAttribute('aria-label', 'Filter categories');
    await expect(page.locator('[data-pl-filtered]')).toBeHidden();

    // Text: a case-insensitive substring of one category.
    const target = p.expenses.categories[0].category;
    const q = (target.length > 3 ? target.slice(1, 4) : target).toUpperCase();
    const hit = (c) => c.toLowerCase().includes(q.toLowerCase());
    await input.fill(q);
    for (const s of ['income', 'expenses']) {
      await expect.poll(() => shownCats(page, rowSel(s)), { message: `${s} filtered by ${q}` }).toEqual(names(s).filter(hit));
      if (!names(s).some(hit)) await expect(page.locator(`[data-pl-table] tbody:has(tr.pl-h) tr.pl-empty`, { hasText: 'No categories match.' }).first()).toBeVisible();
    }
    await expect(page.locator('[data-pl-filtered]')).toBeVisible();
    await expect(page.locator('[data-pl-filtered]')).toContainText(/total/i);
    expect((await hashState(page)).get('q')).toBe(q);
    await input.fill('');
    for (const s of ['income', 'expenses']) await expect.poll(() => shownCats(page, rowSel(s))).toEqual(names(s));
    await expect(page.locator('[data-pl-filtered]')).toBeHidden();

    // Type: Expenses hides the income group.
    const types = page.locator('[data-pl-types]');
    for (const [t, label] of [['all', 'All'], ['income', 'Income'], ['expenses', 'Expenses']]) await expect(types.locator(`button[data-pl-type="${t}"]`)).toHaveText(label);
    await expect(types.locator('button[data-pl-type="all"]')).toHaveAttribute('aria-pressed', 'true');
    await types.locator('button[data-pl-type="expenses"]').click();
    await expect(types.locator('button[data-pl-type="expenses"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(types.locator('button[data-pl-type="all"]')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => shownCats(page, rowSel('income')), { message: 'no income rows' }).toEqual([]);
    await expect.poll(() => shownCats(page, rowSel('expenses'))).toEqual(names('expenses'));
    await expect(page.locator('[data-pl-filtered]')).toBeVisible();

    // Hide empty rows: relative to the range total, then to the selected month.
    const zero = page.locator('button[data-pl-zero]');
    await expect(zero).toHaveText('Hide empty rows');
    await expect(zero).toHaveAttribute('aria-pressed', 'false');
    await zero.click();
    await expect(zero).toHaveAttribute('aria-pressed', 'true');
    const nonZero = (c, k) => { const v = valueOf(api, 'expenses', c, k); return v != null && v !== 0; };
    await expect.poll(() => shownCats(page, rowSel('expenses')), { message: 'range total not empty' })
      .toEqual(p.expenses.categories.filter((c) => nonZero(c, 'tot')).map((c) => c.category));
    await page.locator(`[data-pl-months] button[data-pl-month="${month}"]`).click();
    await expect(page.locator(`[data-pl-months] button[data-pl-month="${month}"]`)).toHaveAttribute('aria-pressed', 'true');
    const inMonth = p.expenses.categories.filter((c) => nonZero(c, `m:${month}`)).map((c) => c.category);
    await expect.poll(() => shownCats(page, rowSel('expenses')), { message: `${month} cell not empty` }).toEqual(inMonth);

    // Text on top of the rest, then the hash and a reload.
    const q2 = inMonth.length ? inMonth[0].slice(0, 2).toLowerCase() : 'zz';
    await input.fill(q2);
    const want = inMonth.filter((c) => c.toLowerCase().includes(q2));
    await expect.poll(() => shownCats(page, rowSel('expenses'))).toEqual(want);
    const st = await hashState(page);
    expect(st.get('m')).toBe(month);
    expect(st.get('t')).toBe('expenses');
    expect(st.get('z')).toBe('1');
    expect(st.get('q')).toBe(q2);
    if (key !== first.pnl.entity.key) expect(st.get('v')).toBe(key);

    await page.reload();
    await expectH1(page, 'P&L');
    await expect(page.locator(`[data-pl-views] [data-pl-view="${attr(key)}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('input[data-pl-filter]')).toHaveValue(q2);
    await expect(page.locator('[data-pl-types] button[data-pl-type="expenses"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('button[data-pl-zero]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`[data-pl-months] button[data-pl-month="${month}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-pl-months] button[data-pl-month=""]')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => shownCats(page, rowSel('expenses')), { message: 'after reload' }).toEqual(want);
    await expect.poll(() => shownCats(page, rowSel('income'))).toEqual([]);
  });

  test('@pnl2-ac2 a category name opens its rows for the range and a month cell for that month; rows sort by date and amount; the total is the cell; Esc returns focus to the opener', async ({ page, request }) => {
    const api = await getJson(request, '/api/pnl');
    const p = api.pnl;
    const section = mainSection(p);
    const c = busiestCategory(p, section);
    const base = { entity: p.entity.key, from: p.from, to: p.to, section, category: c.category };
    await openPnl(page);
    await expect(page.locator('[data-pl-months] button[data-pl-month=""]')).toHaveText(/All months/);
    await expect(page.locator('[data-pl-months] button[data-pl-month=""]')).toHaveAttribute('aria-pressed', 'true');

    // The category name, no month selected: the range.
    const row = catRow(page, section, c.category);
    const opener = row.locator('th button.pl-cat[data-go="pnlrows"][data-pl-open="cat"]');
    await expect(opener).toHaveText(c.category);
    const spec = await opener.getAttribute('data-id');
    const sp = new URLSearchParams(spec);
    expect([sp.get('k'), sp.get('v'), sp.get('f'), sp.get('t'), sp.get('sec'), sp.get('cat'), sp.has('m')])
      .toEqual(['pnl', p.entity.key, p.from, p.to, section, c.category, false]);
    await opener.click();
    const dlg = recDialog(page);
    await expect(dlg).toBeVisible();
    await expect(dlg).toHaveAttribute('aria-modal', 'true');
    await expect(page).toHaveURL(/#\/pnlrows\//);
    await expect(dlg.locator('#h-dlg-t')).toHaveText(c.category);
    await expect(dlg.locator('[data-pl-dlg-scope]')).toHaveText(spanLabel(p.from, p.to));
    const range = await getJson(request, `/api/pnl/rows?${qs(base)}`);
    expect(range.items.length, 'the category has rows').toBeGreaterThan(1);
    const total = await expectDialogRows(page, range, null);
    await expect.poll(() => shownValue(total), { message: 'the total is the category total' }).toBe(figV(api, c.total));
    expect(figV(range, range.sum)).toBe(figV(api, c.total));

    // Amount sorts descending first, then flips; date sorts by date.
    await dlgTh(page, 'amount').locator('button[data-pl-dlg-sort="amount"]').click();
    await expect(dlgTh(page, 'amount')).toHaveAttribute('aria-sort', 'descending');
    await expect(dlgTh(page, 'date')).toHaveAttribute('aria-sort', 'none');
    const desc = rowValues(range, range.items.map((i) => i.fig)).sort((a, b) => b - a);
    await expect.poll(async () => rowValues(range, (await dlgRowData(page)).map((r) => r.fig)), { message: 'amount descending' }).toEqual(desc);
    await dlgTh(page, 'amount').locator('button[data-pl-dlg-sort="amount"]').click();
    await expect(dlgTh(page, 'amount')).toHaveAttribute('aria-sort', 'ascending');
    await expect.poll(async () => rowValues(range, (await dlgRowData(page)).map((r) => r.fig)), { message: 'amount ascending' }).toEqual([...desc].reverse());
    await dlgTh(page, 'date').locator('button[data-pl-dlg-sort="date"]').click();
    await expect(dlgTh(page, 'amount')).toHaveAttribute('aria-sort', 'none');
    await expect(dlgTh(page, 'date')).toHaveAttribute('aria-sort', /^(ascending|descending)$/);
    const dateDir = await dlgTh(page, 'date').getAttribute('aria-sort');
    const dates = range.items.map((i) => String(i.date)).sort();
    await expect.poll(async () => (await dlgRowData(page)).map((r) => r.date), { message: `date ${dateDir}` })
      .toEqual(dateDir === 'ascending' ? dates : [...dates].reverse());

    // Tab stays inside the dialog.
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('.h-dlg-host')), `Tab ${i} stays in the dialog`).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.h-dlg-host'))).toBe(true);

    await closeWithEscape(page);
    await expect(openerBySpec(page, spec)).toBeFocused();

    // A month cell: that month only, and its total is the cell.
    const month = [...p.months].reverse().find((m) => c.months?.[m]);
    const cellBtn = row.locator(`td[data-pl-m="${month}"] button[data-go="pnlrows"][data-pl-open="cell"]`);
    const cellFig = cellBtn.locator('.fx-fig');
    await expect(cellFig).toHaveAttribute('data-fig', c.months[month]);
    const cellValue = await shownValue(cellFig);
    expect(cellValue).toBe(figV(api, c.months[month]));
    const cellSpec = await cellBtn.getAttribute('data-id');
    expect(new URLSearchParams(cellSpec).get('m')).toBe(month);
    expect(new URLSearchParams(cellSpec).get('cat')).toBe(c.category);
    await cellBtn.click();
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('#h-dlg-t')).toHaveText(c.category);
    await expect(dlg.locator('[data-pl-dlg-scope]')).toHaveText(monthLabel(month));
    const single = await getJson(request, `/api/pnl/rows?${qs({ ...base, month })}`);
    const mTotal = await expectDialogRows(page, single, month);
    await expect.poll(() => shownValue(mTotal), { message: 'the total equals the cell' }).toBe(cellValue);
    await closeWithEscape(page);
    await expect(openerBySpec(page, cellSpec)).toBeFocused();

    // Empty cells are not row openers.
    for (const m of p.months.filter((mm) => !c.months?.[mm])) {
      await expect(row.locator(`td[data-pl-m="${m}"] button[data-go="pnlrows"]`)).toHaveCount(0);
    }
    // The range total is a plain figure, not a row opener.
    await expect(row.locator('td[data-pl-tot] .fx-fig')).toHaveAttribute('data-fig', c.total);
    await expect(row.locator('td[data-pl-tot] button[data-go="pnlrows"]')).toHaveCount(0);
  });

  test('@pnl2-ac3 with a month selected the category name lists only that month and the Ask references carry the month, business and household', async ({ page, request }) => {
    const api = await getJson(request, '/api/pnl');
    const p = api.pnl;
    const section = mainSection(p);
    const c = busiestCategory(p, section);
    const month = p.months.find((m) => c.months?.[m] && m !== p.to) || p.months.find((m) => c.months?.[m]);
    const key = p.entity.key;
    await openPnl(page);

    const row = catRow(page, section, c.category);
    const plus = row.locator('button.h-add[data-ctx-add="pnl"]');
    await expect(plus).toHaveAttribute('data-ctx-id', `${key}|${c.category}`);
    await page.locator(`[data-pl-months] button[data-pl-month="${month}"]`).click();
    await expect(page.locator(`[data-pl-months] button[data-pl-month="${month}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-pl-months] button[data-pl-month=""]')).toHaveAttribute('aria-pressed', 'false');
    expect((await hashState(page)).get('m')).toBe(month);
    await expect(sortTh(page, `m:${month}`)).toHaveClass(/\bsel\b/);
    await expect(row.locator(`td[data-pl-m="${month}"]`)).toHaveClass(/\bsel\b/);
    await expect(plus).toHaveAttribute('data-ctx-id', `${key}|${c.category}|${month}`);
    expect(await plus.getAttribute('data-ctx-id')).toMatch(/\|\d{4}-\d{2}$/);

    const opener = row.locator('th button.pl-cat[data-go="pnlrows"][data-pl-open="cat"]');
    const spec = await opener.getAttribute('data-id');
    expect(new URLSearchParams(spec).get('m')).toBe(month);
    await opener.click();
    const dlg = recDialog(page);
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('[data-pl-dlg-scope]')).toHaveText(monthLabel(month));
    const single = await getJson(request, `/api/pnl/rows?${qs({ entity: key, from: p.from, to: p.to, section, category: c.category, month })}`);
    const total = await expectDialogRows(page, single, month);
    await expect.poll(() => shownValue(total), { message: 'the month total' }).toBe(figV(api, c.months[month]));
    await expect(dlg.locator('button.h-add[data-ctx-add="pnl"]').first()).toHaveAttribute('data-ctx-id', `${key}|${c.category}|${month}`);
    await closeWithEscape(page);
    await expect(openerBySpec(page, spec)).toBeFocused();

    // All months clears the month from the references.
    await page.locator('[data-pl-months] button[data-pl-month=""]').click();
    await expect(page.locator('[data-pl-months] button[data-pl-month=""]')).toHaveAttribute('aria-pressed', 'true');
    await expect(plus).toHaveAttribute('data-ctx-id', `${key}|${c.category}`);
    expect((await hashState(page)).has('m')).toBe(false);

    // Household: the same rule with spending references.
    await page.locator('[data-pl-views] [data-pl-view="household"]').click();
    await expect(page.locator('[data-pl-household]')).toBeVisible();
    const spApi = await getJson(request, '/api/spending');
    const sp = spApi.spending;
    const bucket = sp.buckets.find((b) => b.categories.some((x) => Object.values(x.months || {}).some(Boolean)));
    const hc = bucket.categories.find((x) => Object.values(x.months || {}).some(Boolean));
    const hm = sp.months.find((m) => hc.months?.[m]);
    const hrow = page.locator(`[data-pl-table] tr[data-pl-row][data-pl-bucket="${attr(bucket.bucket)}"][data-pl-cat-row="${attr(hc.category)}"]`);
    const hplus = hrow.locator('button.h-add[data-ctx-add="spending"]');
    await expect(hplus).toHaveAttribute('data-ctx-id', hc.category);
    await page.locator(`[data-pl-months] button[data-pl-month="${hm}"]`).click();
    await expect(page.locator(`[data-pl-months] button[data-pl-month="${hm}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(hplus).toHaveAttribute('data-ctx-id', `${hc.category}|${hm}`);
    const hopener = hrow.locator('th button.pl-cat[data-go="pnlrows"][data-pl-open="cat"]');
    const hspec = new URLSearchParams(await hopener.getAttribute('data-id'));
    expect([hspec.get('k'), hspec.get('b'), hspec.get('cat'), hspec.get('m')]).toEqual(['spend', bucket.bucket, hc.category, hm]);
    await hopener.click();
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('[data-pl-dlg-scope]')).toHaveText(monthLabel(hm));
    const hrows = await getJson(request, `/api/spending/rows?${qs({ from: sp.from, to: sp.to, bucket: bucket.bucket, category: hc.category, month: hm })}`);
    const htotal = await expectDialogRows(page, hrows, hm);
    await expect.poll(() => shownValue(htotal), { message: 'the household month total' }).toBe(figV(spApi, hc.months[hm]));
    await expect(dlg.locator('button.h-add[data-ctx-add="spending"]').first()).toHaveAttribute('data-ctx-id', `${hc.category}|${hm}`);
    await closeWithEscape(page);
  });

  test('@pnl2-ac5 @mobile sort by a month, filter to expenses, open a category for that month: the dialog total equals the cell, full screen on a phone', async ({ page, request }) => {
    const api = await getJson(request, '/api/pnl');
    const p = api.pnl;
    expect(p.expenses.categories.length, 'the demo P&L has expenses').toBeGreaterThan(0);
    const month = busiestMonth(p, 'expenses');
    const vp = page.viewportSize();
    await openPnl(page);

    // Phone width shows only the selected month column, so select the month first everywhere.
    await page.locator(`[data-pl-months] button[data-pl-month="${month}"]`).click();
    await expect(page.locator(`[data-pl-months] button[data-pl-month="${month}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(sortTh(page, `m:${month}`)).toBeVisible();

    await clickSort(page, `m:${month}`);
    await expectSort(page, `m:${month}`, 'descending');
    const order = expectedOrder(api, 'expenses', p.expenses.categories, `m:${month}`, 'descending');
    await expect.poll(() => shownCats(page, rowSel('expenses')), { message: 'expenses by month descending' }).toEqual(order);

    await page.locator('[data-pl-types] button[data-pl-type="expenses"]').click();
    await expect(page.locator('[data-pl-types] button[data-pl-type="expenses"]')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => shownCats(page, rowSel('income')), { message: 'no income rows' }).toEqual([]);
    await expect.poll(() => shownCats(page, rowSel('expenses'))).toEqual(order);

    const byName = new Map(p.expenses.categories.map((x) => [x.category, x]));
    const c = byName.get(order.find((n) => byName.get(n).months?.[month]));
    expect(c, `an expense category has a ${month} cell`).toBeTruthy();
    const cellBtn = catRow(page, 'expenses', c.category).locator(`td[data-pl-m="${month}"] button[data-go="pnlrows"][data-pl-open="cell"]`);
    await expect(cellBtn).toBeVisible();
    const cellValue = await shownValue(cellBtn.locator('.fx-fig'));
    expect(cellValue).toBe(figV(api, c.months[month]));
    const cellSpec = await cellBtn.getAttribute('data-id');
    await cellBtn.click();

    const dlg = recDialog(page);
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('#h-dlg-t')).toHaveText(c.category);
    await expect(dlg.locator('[data-pl-dlg-scope]')).toHaveText(monthLabel(month));
    const single = await getJson(request, `/api/pnl/rows?${qs({ entity: p.entity.key, from: p.from, to: p.to, section: 'expenses', category: c.category, month })}`);
    const total = await expectDialogRows(page, single, month);
    await expect.poll(() => shownValue(total), { message: 'the dialog total equals the cell' }).toBe(cellValue);

    if (vp.width < 720) {
      const box = await dlg.boundingBox();
      expect(box, 'the dialog has a box').toBeTruthy();
      expect(Math.abs(box.x), 'left edge').toBeLessThanOrEqual(1);
      expect(Math.abs(box.y), 'top edge').toBeLessThanOrEqual(1);
      expect(Math.abs(box.width - vp.width), 'full width').toBeLessThanOrEqual(1);
      expect(Math.abs(box.height - vp.height), 'full height').toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: test.info().outputPath(`pnl-rows-dialog-${vp.width}.png`) });

    await closeWithEscape(page);
    await expect(openerBySpec(page, cellSpec)).toBeFocused();
    await expectSort(page, `m:${month}`, 'descending');
    await expect(page.locator('[data-pl-types] button[data-pl-type="expenses"]')).toHaveAttribute('aria-pressed', 'true');
  });
});
