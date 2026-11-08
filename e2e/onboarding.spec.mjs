// Onboarding in three steps: 0 the demo sign-in line, then 3 Tell us (the note saved through ingest,
// files and connections), 4 Here is what we heard (derived from stored facts), 5 Building your
// year. The Goals (1) and Curve (2) steps were cut (SX5); their links land on Tell us. Home on a
// store with no open goals shows the Goals block (starter cards, write your own, the Add your
// spouse line). Two parts.
//
// 1. The demo build (the shared demo server), served as a fresh store on each step, or with every
//    goal deleted for the Home empty state, or made genuinely fresh in its store for the full path.
// 2. A real-mode store past first run, on its own server (FATHOM_DEMO=0, engine off, synthetic enrolled
//    admin session), where Setup on the Settings page lands on Tell us, the heard step lists the
//    stored household with provenance and edit links, and finishing Setup keeps every goal and file.
//
// Desktop and 390px. Real-mode URLs are absolute to its own server, so the configured baseURL is
// ignored there.

import { test, expect, expectH1, gotoRoute, fetchScenario, REMOTE, resetDemo } from './helpers.mjs';
import { openDb, setSetting } from '../src/store/db.mjs';
import { createLocalData, householdStoreFile, localDataDir, removeLocalData, startEnrolledServer } from './local-store.mjs';
import { upsertFact } from '../src/store/facts.mjs';
import { ask, FACT_CHECK_OPTIONS } from '../src/ingest/confirm.mjs';

const NOTE = 'We file jointly in Virginia, I run an S corporation and my spouse freelances. Two kids.';

// The Goals step copy and its starter cards (pinned by the design).
const GOALS_H1 = 'What is the money for?';
const GOALS_LEDE = 'Fathom can only say if you are ahead or behind once it knows where you are going. Pick a few or write your own. You can change them any time.';
const STARTER_CARDS = [
  { id: 'cushion', title: 'A cash cushion', sub: 'Months of spending you never touch', horizon: 'now' },
  { id: 'work-optional', title: 'Work less, on our terms', sub: 'The year work becomes optional', horizon: '3-10y' },
  { id: 'family', title: 'Kids and family', sub: 'School, childcare, a new arrival', horizon: '1-3y' },
  { id: 'tax', title: 'Pay less tax, without stress', sub: 'Use every window before Dec 31', horizon: 'now' }
];
const STARTER = Object.fromEntries(STARTER_CARDS.map((s) => [s.id, s]));
const INVITE_SENTENCE = 'They see their own actions and the same goals.';
const RAIL = ['Tell us', 'What we understood', 'Build'];

test.describe.configure({ mode: 'serial' });
test.skip(REMOTE, 'starts its own local server and writes notes; not part of a remote smoke run');

/* ---------- shared locators and actions ---------- */

const goalsStart = (page) => page.locator('[data-goals-start]');
const starterCard = (page, id) => goalsStart(page).locator(`button[data-goal-starter="${id}"]`);
const kicker = (page) => page.locator('.h-ob-card [data-ob-kicker]');
const continueBtn = (page) => page.getByRole('button', { name: 'Continue', exact: true });

// Tap on a touch project, click elsewhere.
async function press(locator, hasTouch) {
  if (hasTouch) await locator.tap();
  else await locator.click();
}

async function expectRail(page) {
  await expect(page.locator('.h-ob-steps span')).toHaveText(RAIL);
}

// Records the JSON body of every POST /api/goals the page sends.
function recordGoalPosts(page) {
  const bodies = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/goals') bodies.push(req.postDataJSON());
  });
  return bodies;
}

/* ---------- part 1: the demo build ---------- */

// The demo store has finished onboarding; serve every scenario as a fresh one on the given step.
async function forceFresh(page, step) {
  await page.route('**/api/**', async (route) => {
    const res = await route.fetch();
    if (!String(res.headers()['content-type'] || '').includes('application/json')) return route.fulfill({ response: res });
    const body = await res.json();
    const sc = body && body.meta ? body : body && body.scenario;
    if (sc && sc.live) Object.assign(sc.live, { demo: 'fresh', onboardStep: step });
    return route.fulfill({ response: res, json: body });
  });
}

// Deletes every goal in the demo store (archived ones too), so Home has no open goals.
async function deleteAllGoals(request) {
  const sc = await fetchScenario(request);
  for (const g of sc.goals) {
    const res = await request.post(`/api/goals/${encodeURIComponent(g.id)}/delete`, { headers: { 'content-type': 'application/json' }, data: {} });
    expect(res.status(), `delete goal ${g.id}`).toBe(200);
  }
  expect((await fetchScenario(request)).goals).toEqual([]);
}

// Makes the demo store genuinely fresh: onboarding not done, on the sign-in step. The server reads
// the setting on every scenario build; resetDemo reseeds it as done.
function makeDemoFresh() {
  const db = openDb(householdStoreFile(localDataDir()));
  try {
    setSetting(db, 'onboarding', { done: false, step: 0 });
  } finally {
    db.close();
  }
}

test.describe('demo build', () => {
  test.beforeEach(async ({ request }) => { await resetDemo(request); });
  test.afterEach(async ({ page, request }) => {
    await page.unrouteAll({ behavior: 'wait' });
    await resetDemo(request);
  });

  test('sign-in step: an honest private-network line, no fake passkey @mobile', async ({ page }) => {
    await forceFresh(page, 0);
    await page.goto('/#/onboarding/0');
    const who = page.locator('[data-ob-who]');
    await expect(who).toBeVisible();
    await expect(who).toContainText('private network');
    await expect(who).not.toContainText('Signed in through');
    await expect(page.locator('body')).not.toContainText('passkey');
    await expect(page.locator('body')).not.toContainText('Demo sign-in');
    await expect(page.locator('input[type=email]')).toHaveCount(0);
    await expect(page.locator('form[data-signin]')).toHaveCount(0);
    await continueBtn(page).click();
    await expect(page).toHaveURL(/#\/onboarding\/3$/);
    await expectH1(page, 'Dump everything in');
  });

  test('Tell us: the note is saved through ingest and what was understood is shown @mobile', async ({ page, request }) => {
    await forceFresh(page, 3);
    await page.goto('/#/onboarding/3');
    await expectH1(page, 'Dump everything in');
    await expect(continueBtn(page)).toBeVisible();
    const box = page.locator('textarea[data-dump]');
    await expect(box).toHaveValue('');
    await box.fill(NOTE);
    const saved = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/onboarding/notes' && r.request().method() === 'POST');
    await page.getByRole('button', { name: /Save and read/ }).click();
    const res = await saved;
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.file.parser).toBe('notes');
    const panel = page.locator('[data-understood]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Saved');
    await expect(box).toHaveValue('');
    await expect(continueBtn(page)).toBeVisible();
    // It is a real notes file in the store, listed with the others.
    const files = await (await request.get('/api/files')).json();
    expect(files.files.some((f) => /^Setup notes \d{4}-\d{2}-\d{2}\.md$/.test(f.name))).toBe(true);
    // Continue goes on to what we heard.
    await continueBtn(page).click();
    await expect(page).toHaveURL(/#\/onboarding\/4$/);
    await expectH1(page, 'Here is what we heard');
  });

  test('every step renders, and Here is what we heard lists stored facts with provenance @mobile', async ({ page }) => {
    await forceFresh(page, 4);
    await page.goto('/#/onboarding/4');
    await expectH1(page, 'Here is what we heard');
    const filing = page.locator('[data-heard-item="fact:household.filingStatus"]');
    await expect(filing).toContainText('Married filing jointly');
    await expect(filing).toContainText('From demo scenario');
    await expect(page.locator('[data-heard="accounts"]')).toBeVisible();
    // Nothing from the old hand-written mock content is shown.
    await expect(page.locator('.h-heards')).not.toContainText('Life events');
    // Away from the app, edit goes back to Tell us.
    await filing.getByRole('link', { name: 'Correct in notes' }).click();
    await expect(page).toHaveURL(/#\/onboarding\/3$/);
    await expectH1(page, 'Dump everything in');
    for (const step of [1, 2, 5]) {
      await page.goto(`/#/onboarding/${step}`);
      await expect(page.locator('.h-ob-card h1')).toBeVisible();
    }
    // The cut Goals and Curve steps land on Tell us.
    for (const step of [1, 2]) {
      await page.goto(`/#/onboarding/${step}`);
      await expect(page).toHaveURL(/#\/onboarding\/3$/);
      await expectH1(page, 'Dump everything in');
    }
  });

  test('three steps: Tell us, What we understood and Build, each lighting its rail stop', { tag: ['@ob-ac1', '@mobile'] }, async ({ page, hasTouch }) => {
    await forceFresh(page, 3);
    await page.goto('/#/onboarding/3');

    // Step 1: Tell us, with files and connections. No goals and no curve before it.
    await expect(kicker(page)).toHaveText('Step 1 of 3');
    await expectH1(page, 'Dump everything in');
    await expect(page.locator('textarea[data-dump]')).toBeVisible();
    await expect(page.locator('input[type=file][data-upload]')).toHaveCount(1);
    await expect(page.locator('[data-sf-box]')).toBeVisible();
    await expect(page.getByText('Already in Fathom, not mirrored')).toBeVisible();
    await expect(page.locator('input[type=range]')).toHaveCount(0);
    await expectRail(page);
    await expect(page.locator('.h-ob-rail circle')).toHaveCount(RAIL.length);
    await expect(page.locator('.h-ob-rail circle.cur')).toHaveCount(1);
    await expect(page.locator('.h-ob-rail circle.done')).toHaveCount(0);
    await press(continueBtn(page), hasTouch);

    // Step 2: what we understood.
    await expect(page).toHaveURL(/#\/onboarding\/4$/);
    await expect(kicker(page)).toHaveText('Step 2 of 3');
    await expectH1(page, 'Here is what we heard');
    await expectRail(page);
    await expect(page.locator('.h-ob-rail circle.done')).toHaveCount(1);
    await press(page.getByRole('button', { name: 'Looks right' }), hasTouch);

    // Step 3: building the year.
    await expect(page).toHaveURL(/#\/onboarding\/5$/);
    await expect(page.locator('.h-ob-card h1')).toBeVisible();
    await expect(page.locator('.h-ob-rail circle.done')).toHaveCount(2);
    await expect(page.locator('.h-ob-rail circle.cur')).toHaveCount(1);
  });

  test('starters and own goals become goals, with only the targets Fathom sets, on Home and on Goals', { tag: ['@ob-ac2', '@mobile'] }, async ({ page, request, hasTouch }) => {
    await deleteAllGoals(request);
    await gotoRoute(page, 'home');
    const block = goalsStart(page);
    await expect(block).toBeVisible();
    await expectH1(page, GOALS_H1);
    await expect(block).toContainText(GOALS_LEDE);

    // Four starter cards and the write-your-own card, all unselected.
    await expect(block.locator('button[data-goal-starter]')).toHaveCount(STARTER_CARDS.length);
    for (const s of STARTER_CARDS) {
      const card = starterCard(page, s.id);
      await expect(card).toHaveAttribute('type', 'button');
      await expect(card).toContainText(s.title);
      await expect(card).toContainText(s.sub);
      await expect(card).toHaveAttribute('aria-pressed', 'false');
    }
    const own = block.locator('button[data-goal-own]');
    await expect(own).toHaveCount(1);
    await expect(own).toContainText('Write your own');
    await expect(own).toContainText('In your words. Fathom asks for a target later.');

    // Keyboard toggles a card both ways: Space selects, Enter clears.
    const cushion = starterCard(page, 'cushion');
    await cushion.focus();
    await page.keyboard.press('Space');
    await expect(cushion).toHaveAttribute('aria-pressed', 'true');
    await cushion.focus();
    await page.keyboard.press('Enter');
    await expect(cushion).toHaveAttribute('aria-pressed', 'false');

    // Tap or click selects.
    await press(cushion, hasTouch);
    await expect(cushion).toHaveAttribute('aria-pressed', 'true');
    await press(starterCard(page, 'family'), hasTouch);
    await expect(starterCard(page, 'family')).toHaveAttribute('aria-pressed', 'true');
    await expect(starterCard(page, 'tax')).toHaveAttribute('aria-pressed', 'false');

    // Write your own: Enter adds, a blank Add adds nothing, Add adds, an entry can be removed.
    await press(own, hasTouch);
    const input = block.locator('input[data-goal-own-input]');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('maxlength', '120');
    await input.fill('Sabbatical in the mountains');
    await input.press('Enter');
    const items = block.locator('[data-goal-own-item]');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Sabbatical in the mountains');
    const add = block.getByRole('button', { name: 'Add', exact: true });
    await input.fill('   ');
    await press(add, hasTouch);
    await expect(items).toHaveCount(1);
    await input.fill('Learn to sail');
    await press(add, hasTouch);
    await expect(items).toHaveCount(2);
    const sail = items.filter({ hasText: 'Learn to sail' });
    await press(sail.getByRole('button', { name: /Remove/ }), hasTouch);
    await expect(items).toHaveCount(1);
    await expect(block).not.toContainText('Learn to sail');

    // Save goals creates exactly the selected ones, with no target and no target date.
    const posts = recordGoalPosts(page);
    await press(block.getByRole('button', { name: 'Save goals' }), hasTouch);
    await expect(goalsStart(page)).toHaveCount(0);
    await expect.poll(() => posts.length).toBe(3);
    const expected = [
      { title: STARTER.cushion.title, note: STARTER.cushion.sub, horizon: STARTER.cushion.horizon },
      { title: STARTER.family.title, note: STARTER.family.sub, horizon: STARTER.family.horizon },
      { title: 'Sabbatical in the mountains', note: '', horizon: 'now' }
    ];
    expect([...posts].sort((a, b) => a.title.localeCompare(b.title))).toEqual([...expected].sort((a, b) => a.title.localeCompare(b.title)));
    for (const b of posts) {
      expect(Object.hasOwn(b, 'target'), `${b.title} sends no target`).toBe(false);
      expect(Object.hasOwn(b, 'targetDate'), `${b.title} sends no targetDate`).toBe(false);
    }

    // Stored as owner goals. The client sends no target; any target a goal has, Fathom set from its
    // calculator (the cushion starter on the demo data), never the owner by accident.
    const sc = await fetchScenario(request);
    expect(sc.goals.map((g) => g.title).sort()).toEqual(expected.map((e) => e.title).sort());
    for (const e of expected) {
      const g = sc.goals.find((x) => x.title === e.title);
      expect(g).toMatchObject({ origin: 'owner', archived: false, note: e.note, horizon: e.horizon });
      expect(Boolean(g.adopted), `${e.title}: a target only when Fathom set it`).toBe(Number.isFinite(g.target));
    }

    // Home redraws with them: each goal is its own card, with no quiet row.
    // Match on the card title: a question's why text can name another goal's words.
    const homeGoal = (title) => page.locator('section.h-home article.h-gcard[data-goal-card]')
      .filter({ has: page.locator('.h-gcard-t', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
    for (const e of expected) {
      const g = sc.goals.find((x) => x.title === e.title);
      await expect(homeGoal(e.title)).toHaveCount(1);
      await expect(homeGoal(e.title)).toHaveAttribute('data-goal-card', g.id);
    }
    await expect(page.locator('section.h-home details.h-quiet, section.h-home [data-quiet-goal]')).toHaveCount(0);

    // And they are on Goals.
    await gotoRoute(page, 'goals');
    await expectH1(page, 'Where you are headed');
    for (const e of expected) {
      await expect(page.locator('article.h-goal', { has: page.locator('.h-goal-h b', { hasText: e.title }) })).toHaveCount(1);
    }
  });

  test('demo: the Add your spouse line explains, with no link', { tag: ['@ob-ac3', '@mobile'] }, async ({ page, request }) => {
    await deleteAllGoals(request);
    await gotoRoute(page, 'home');
    await expectH1(page, GOALS_H1);
    const invite = page.locator('[data-ob-invite]');
    await expect(invite).toBeVisible();
    await expect(invite).toHaveAttribute('data-kind', 'text');
    await expect(invite).toContainText(INVITE_SENTENCE);
    await expect(invite.locator('a')).toHaveCount(0);
    await expect(page.locator('a[href="/admin/users"]')).toHaveCount(0);
  });

  test('Home with no open goals shows the Goals block; with goals it is the normal Home', { tag: ['@ob-ac4', '@mobile'] }, async ({ page, request }) => {
    await deleteAllGoals(request);
    await gotoRoute(page, 'home');
    await expect(page).toHaveURL(/#\/home$/);
    const block = goalsStart(page);
    await expect(block).toBeVisible();
    await expectH1(page, GOALS_H1);
    await expect(block.locator('button[data-goal-starter]')).toHaveCount(STARTER_CARDS.length);
    await expect(block.getByRole('button', { name: 'Save goals' })).toBeVisible();
    await expect(page.locator('[data-goal-card]')).toHaveCount(0);
    // Inside the normal shell, not the onboarding frame.
    await expect(page.locator('header.h-top')).toBeVisible();
    await expect(page.locator('.h-ob-card')).toHaveCount(0);

    await resetDemo(request);
    await page.reload();
    await expect(page.locator('section.h-home')).toBeVisible();
    expect(await page.locator('section.h-home [data-goal-card]').count()).toBeGreaterThan(0);
    await expect(goalsStart(page)).toHaveCount(0);
  });

  test('a fresh demo store is forced through onboarding and finishes on Home', { tag: ['@ob-ac5', '@mobile'] }, async ({ page, request, hasTouch }) => {
    makeDemoFresh();
    const goalsBefore = (await fetchScenario(request)).goals.map((g) => g.id).sort();
    const posts = recordGoalPosts(page);

    await page.goto('/#/home');
    await expect(page).toHaveURL(/#\/onboarding\/0$/);
    await expect(page.locator('[data-ob-who]')).toBeVisible();
    await press(continueBtn(page), hasTouch);

    await expect(page).toHaveURL(/#\/onboarding\/3$/);
    await expectH1(page, 'Dump everything in');
    await press(continueBtn(page), hasTouch);

    await expect(page).toHaveURL(/#\/onboarding\/4$/);
    await expectH1(page, 'Here is what we heard');
    await press(page.getByRole('button', { name: 'Looks right' }), hasTouch);

    await expect(page).toHaveURL(/#\/onboarding\/5$/);
    const open = page.getByRole('button', { name: /Open my first brief/ });
    await expect(open).toBeVisible({ timeout: 15_000 });
    await press(open, hasTouch);
    await expect(page).toHaveURL(/#\/home$/);
    await expect(page.locator('section.h-home')).toBeVisible();

    const sc = await fetchScenario(request);
    expect(sc.live.demo).toBe('november');
    // Onboarding asks for no goals: it created nothing and removed nothing.
    expect(posts).toEqual([]);
    expect(sc.goals.map((g) => g.id).sort()).toEqual(goalsBefore);
  });
});

/* ---------- part 2: a real store past first run ---------- */

let BASE;
let DATA_DIR;
let DB_FILE;
let app;

// A returning owner: one note file with facts (one of them asked), an entity, an account. No goals.
function seedHousehold() {
  const db = openDb(DB_FILE);
  const now = '2026-11-05T12:00:00.000Z';
  try {
    db.prepare("INSERT INTO files (id, name, mime, size, uploaded_at, status) VALUES ('f-e2e-note', 'earlier-notes.md', 'text/markdown', 1, ?, 'imported')").run(now);
    const prov = { fileId: 'f-e2e-note', parser: 'extract-notes' };
    upsertFact(db, { key: 'household.filingStatus', value: 'mfj', provenance: prov, now });
    upsertFact(db, { key: 'household.state', value: 'VA', provenance: prov, now });
    upsertFact(db, { key: 'household.dependents', value: 2, provenance: prov, now });
    upsertFact(db, { key: 'income.sCorp', value: true, confirmed: true, src: 'you', now });
    ask(db, { kind: 'fact_check', subject: 'src|household.dependents|2', question: 'An import says household.dependents is 2. Is that right?', options: FACT_CHECK_OPTIONS, context: { key: 'household.dependents', value: 2 }, fileId: 'f-e2e-note', now });
    db.prepare("INSERT INTO pnl_lines (entity, period, category, amount, file_id, parser) VALUES ('Northwind Advisory', '2026-01', 'Income', 100, 'f-e2e-note', 'pnl-workbook')").run();
    db.prepare("INSERT INTO accounts (id, inst, name, owner, kind, mirror, parser) VALUES ('acct-e2e-ob', 'Synthetic Bank', 'Synthetic Checking', 'owner', 'checking', 'manual', 'e2e')").run();
  } finally {
    db.close();
  }
}

// Requests to the real server as the enrolled admin, outside the browser.
async function realGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: app.headers });
  expect(res.status, `GET ${path}`).toBe(200);
  return res.json();
}
async function realPost(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { ...app.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, `POST ${path}`).toBe(200);
  return res.json();
}

async function openSetup(page) {
  await page.goto(`${BASE}/`);
  await expect(page).toHaveURL(/#\/home$/);
  await page.locator('header.h-top a.h-gear').click();
  await expect(page).toHaveURL(/#\/settings$/);
  const setup = page.locator('section.h-settings a[data-go="onboarding"]', { hasText: 'Setup' });
  await expect(setup).toBeVisible();
  await expect(page.locator('section.h-settings li.h-set-r', { has: page.locator('a[data-go="onboarding"]', { hasText: 'Setup' }) })).toContainText('Tell Fathom more about the household, in notes and files.');
  await setup.click();
  await expect(page).toHaveURL(/#\/onboarding\/3$/);
  await expectH1(page, 'Dump everything in');
}

test.describe('real store past first run', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000); // a busy runner can take a while to start a server
    DATA_DIR = createLocalData('onboarding');
    app = await startEnrolledServer({ dataDir: DATA_DIR });
    DB_FILE = app.storeFile;
    BASE = app.url;
    seedHousehold();
  });

  test.afterAll(async () => {
    if (app) await app.close();
    removeLocalData(DATA_DIR);
  });

  test.beforeEach(async ({ context }) => {
    await app.authenticate(context);
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({
      status: 200, body: '', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    }));
  });

  test('Setup on the Settings page opens Tell us; the note is saved while the engine is off; the heard step lists the household @mobile', async ({ page, context }) => {
    await openSetup(page);
    await expect(kicker(page)).toHaveText('Step 1 of 3');
    await expect(page.locator('.h-ob-steps')).not.toContainText('Sign in');
    await expect(page.locator('body')).not.toContainText('passkey');
    await expect(page.getByRole('link', { name: 'Back to the app' })).toBeVisible();
    // A real store has no welcome step to go back to.
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);

    // Tell us: saved encrypted, waiting for the engine.
    await page.locator('textarea[data-dump]').fill(NOTE);
    const saved = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/onboarding/notes' && r.request().method() === 'POST');
    await page.getByRole('button', { name: /Save and read/ }).click();
    const res = await saved;
    expect(res.status()).toBe(200);
    expect((await res.json()).file.status).toBe('needs_extraction');
    const panel = page.locator('[data-understood]');
    await expect(panel).toContainText('The engine is off');
    await expect(panel).not.toContainText('Virginia');
    const files = await (await context.request.get(`${BASE}/api/files`, { headers: app.contextHeaders })).json();
    const note = files.files.find((f) => /^Setup notes /.test(f.name));
    expect(note && note.status).toBe('needs_extraction');

    // The connections block sits on the same step; Continue goes on to the heard step.
    await expect(page.locator('[data-sf-box]')).toBeVisible();
    await continueBtn(page).click();
    await expect(page).toHaveURL(/#\/onboarding\/4$/);
    await expectH1(page, 'Here is what we heard');
    const state = page.locator('[data-heard-item="fact:household.state"]');
    await expect(state).toContainText('VA');
    await expect(state).toContainText('From earlier-notes.md');
    await expect(page.locator('[data-heard-item="fact:household.filingStatus"]')).toContainText('Married filing jointly');
    await expect(page.locator('[data-heard-item="fact:income.sCorp"]')).toContainText('confirmed by you');
    await expect(page.locator('[data-heard-item="entity:Northwind Advisory"]')).toContainText('From earlier-notes.md');
    await expect(page.locator('[data-heard-item="accounts:checking"]')).toContainText('1');
    await expect(page.locator('[data-heard-item="accounts:checking"]').getByRole('link', { name: 'Edit in Accounts' })).toBeVisible();
    // A value the store does not hold is not shown.
    await expect(page.locator('.h-heards')).not.toContainText('Expecting a child');
    await expect(page.locator('[data-heard-open] b')).toHaveText('1');
    await expect(page.locator('[data-heard-open]')).toContainText('question is still open');

    // The asked fact links to the real Confirm deck.
    await page.locator('[data-heard-item="fact:household.dependents"]').getByRole('link', { name: 'Review in Confirm' }).click();
    await expect(page).toHaveURL(/#\/confirm$/);
  });

  test('Setup finishes back on Home, and Back to the app leaves at any step', async ({ page }) => {
    await page.goto(`${BASE}/#/onboarding/5`);
    await expect(page.locator('.h-ob-card h1')).toBeVisible();
    await page.getByRole('button', { name: /Back to my brief/ }).click({ timeout: 15_000 });
    await expect(page).toHaveURL(/#\/home$/);
    // Completing onboarding on a signed-in instance starts the guided tour (it may still be
    // waiting for a stop's anchor on this sparse store); Escape dismisses it either way, and that
    // clears the user's flag on the server.
    await page.keyboard.press('Escape');
    await expect(page.locator('.h-tour')).toHaveCount(0);
    await expect.poll(async () => (await realGet('/api/scenario')).live.tourPending, { timeout: 15_000 }).toBe(false);
    await page.goto(`${BASE}/#/onboarding`);
    await expect(page).toHaveURL(/#\/onboarding\/3$/);
    await page.getByRole('link', { name: 'Back to the app' }).click();
    await expect(page).toHaveURL(/#\/home$/);
  });

  // The spouse line sits in the Goals block, which a store shows on Home while it has no open goals.
  test('real store admin: Add your spouse links to the household page', { tag: ['@ob-ac3', '@mobile'] }, async ({ page }) => {
    await page.goto(`${BASE}/#/home`);
    await expectH1(page, GOALS_H1);
    const invite = page.locator('[data-ob-invite]');
    await expect(invite).toBeVisible();
    await expect(invite).toHaveAttribute('data-kind', 'link');
    await expect(invite).toContainText(INVITE_SENTENCE);
    const link = invite.getByRole('link', { name: 'Add your spouse', exact: true });
    await expect(link).toHaveAttribute('href', '/admin/users');
  });

  test('Setup on a store with goals keeps them and every file, and asks for no goals', { tag: ['@ob-ac5', '@mobile'] }, async ({ page, hasTouch }) => {
    const cushion = (await realPost('/api/goals', { title: 'A cash cushion', horizon: 'now' })).goal;
    const roof = (await realPost('/api/goals', { title: 'Replace the roof', note: 'Before the rainy season', horizon: '1-3y' })).goal;
    const filesBefore = (await realGet('/api/files')).files.map((f) => f.name);
    expect(filesBefore).toContain('earlier-notes.md');

    // Home has open goals, so it is the normal Home.
    await page.goto(`${BASE}/`);
    await expect(page).toHaveURL(/#\/home$/);
    await expect(page.locator('section.h-home')).toBeVisible();
    await expect(goalsStart(page)).toHaveCount(0);

    const posts = recordGoalPosts(page);
    await openSetup(page);
    await expect(goalsStart(page)).toHaveCount(0);
    await press(continueBtn(page), hasTouch);
    await expect(page).toHaveURL(/#\/onboarding\/4$/);
    await press(page.getByRole('button', { name: 'Looks right' }), hasTouch);
    await expect(page).toHaveURL(/#\/onboarding\/5$/);
    const back = page.getByRole('button', { name: /Back to my brief/ });
    await expect(back).toBeVisible({ timeout: 15_000 });
    await press(back, hasTouch);
    await expect(page).toHaveURL(/#\/home$/);

    // Every goal is still there and open, none was added, no file was lost.
    expect(posts).toEqual([]);
    const sc = await realGet('/api/scenario');
    const open = sc.goals.filter((g) => !g.archived);
    expect(open.map((g) => g.id).sort()).toEqual([cushion.id, roof.id].sort());
    const filesAfter = (await realGet('/api/files')).files.map((f) => f.name);
    expect(filesAfter).toEqual(expect.arrayContaining(filesBefore));
  });
});
