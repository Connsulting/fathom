import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases } from './cases.mjs';
import { runCases } from './harness.mjs';

export async function main(argv = process.argv.slice(2), { scripts } = {}) {
  if (argv.includes('--help')) {
    console.log('Ask evals: node evals/run.mjs [--live --max-usd <budget>] [--cases <id-or-family,...>] [--out <directory>]');
    return 0;
  }
  let live = false, budget, filter, out;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') { live = true; continue; }
    if (!['--max-usd', '--cases', '--out'].includes(arg) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new TypeError('Unknown or incomplete eval option');
    const value = argv[++i];
    if (arg === '--max-usd') budget = Number(value);
    if (arg === '--cases') filter = value.split(',');
    if (arg === '--out') out = resolve(value);
  }
  if (live && process.env.CI) throw new TypeError('Live evals never run in CI');
  if (live && budget === undefined) throw new TypeError('Live evals require --max-usd');
  if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) throw new TypeError('Invalid eval budget');
  let cases = await loadCases();
  if (filter) {
    for (const token of filter) if (!cases.some(c => c.id === token || c.family === token)) throw new TypeError(`Unknown case filter: ${token}`);
    cases = cases.filter(c => filter.includes(c.id) || filter.includes(c.family));
  }
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const dir = out ?? fileURLToPath(new URL(`./out/${timestamp}/`, import.meta.url));
  const scorecard = await runCases({ cases, live, maxUsd: budget ?? 100, outDir: dir, scripts });
  const counts = {};
  for (const c of scorecard.cases) counts[c.status] = (counts[c.status] ?? 0) + 1;
  console.log(JSON.stringify({ cases: scorecard.completed, selected: scorecard.selected, attempted: scorecard.attempted, results: counts,
    reservedUsd: scorecard.reservedUsd, costUsd: scorecard.costUsd, stopped: scorecard.stopped,
    unrun: scorecard.cases.filter(c => c.status === 'unrun').map(({ id, reason }) => ({ id, reason })) }));
  return scorecard.stopped || scorecard.cases.some(c => ['fail', 'xpass'].includes(c.status)) ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`Ask evals: ${error.message}`); process.exitCode = 1; }
}
