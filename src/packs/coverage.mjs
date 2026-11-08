import { getSetting, setSetting } from '../store/db.mjs';

export function knowledgeGap({ stage, name, fileId = null, section = null, reason }) {
  const subject = section ? `Section "${section}" of ${name}` : name;
  return {
    stage, name, fileId, section,
    explanation: `${subject}: ${reason}`,
    action: stage === 'source-read' ? 'replace' : 'rebuild',
    disclosure: stage === 'pack-load'
      ? `${name} could not be loaded, so this answer does not use that pack.`
      : section
        ? `Section "${section}" of your plan document ${name} could not be verified, so this answer does not use that section.`
        : `Your plan document ${name} could not be read, so this answer does not use it.`,
  };
}

export function planCoverage(db) {
  return [...getSetting(db, 'yourPlans.coverage', []), ...getSetting(db, 'yourPlans.loadFailure', [])];
}

export function saveLoadFailure(db, failed) {
  const sources = getSetting(db, 'yourPlans', null)?.sources || [];
  const name = sources.length ? `Your plans (${sources.join(', ')})` : 'Your plans';
  const issues = failed ? [knowledgeGap({ stage: 'pack-load', name,
    reason: 'The saved pack is missing or unreadable. Rebuild it from your documents.' })] : [];
  if (JSON.stringify(getSetting(db, 'yourPlans.loadFailure', [])) !== JSON.stringify(issues)) {
    setSetting(db, 'yourPlans.loadFailure', issues);
  }
}

export function coveredPacks(db, packs) {
  const gaps = planCoverage(db).filter(issue => issue.stage !== 'pack-load');
  if (!gaps.length) return packs;
  return packs.map(pack => {
    if (pack.id !== 'your-plans') return pack;
    const entries = pack.entries.filter(entry => !gaps.some(issue =>
      (!issue.section || entry.title === issue.section) && entry.cites.some(cite =>
        cite.url.startsWith(`https://your-plans.invalid/${encodeURIComponent(issue.fileId ?? issue.name)}?page=`))));
    return { ...pack, entries, covers: entries.map(entry => entry.title) };
  });
}
