export const PARITY_EXCLUDED = Object.freeze({
  "GET /healthz": "health check",
  "GET /api/auth/session": "identity and sessions",
  "POST /api/auth/register/options": "identity and sessions",
  "POST /api/auth/register/verify": "identity and sessions",
  "POST /api/auth/signin/options": "identity and sessions",
  "POST /api/auth/signin/verify": "identity and sessions",
  "POST /api/auth/recover": "identity and sessions",
  "POST /api/auth/signout": "identity and sessions",
  "GET /api/auth/passkeys": "identity and sessions",
  "POST /api/auth/passkeys/link": "identity and sessions",
  "POST /api/auth/passkeys/:id/revoke": "identity and sessions",
  "GET /api/admin/users": "administration",
  "POST /api/admin/users/invite": "administration",
  "POST /api/admin/users/:id/role": "administration",
  "POST /api/admin/users/:id/remove": "administration",
  "POST /api/admin/users/:id/passkeys/:keyId/revoke": "administration",
  "POST /api/auth/invitations/accept": "administration",
  "POST /api/operator/households": "administration",
  "GET /api/identity": "identity and sessions",
  "POST /api/packs/:id/whatif": "conversation chrome",
  "POST /api/engine": "engine controls",
  "POST /api/engine/cap": "engine controls",
  "POST /api/ask": "conversation chrome",
  "GET /api/threads": "conversation chrome",
  "POST /api/threads": "conversation chrome",
  "GET /api/threads/:id": "conversation chrome",
  "POST /api/threads/:id/rename": "conversation chrome",
  "POST /api/threads/:id/archive": "conversation chrome",
  "POST /api/threads/:id/trash": "conversation chrome",
  "POST /api/threads/:id/restore": "conversation chrome",
  "POST /api/threads/:id/delete": "conversation chrome",
  "POST /api/threads/:id/proposals/:messageId": "conversation chrome",
  "POST /api/onboarding": "onboarding wizard",
  "POST /api/tour/seen": "onboarding wizard",
  "POST /api/demo/reset": "demo reset",
  "GET /api/keys": "API keys",
  "POST /api/keys": "API keys",
  "POST /api/keys/:id/revoke": "API keys",
  "GET /api/mcp": "API keys",
  "GET /api/email/subscriptions": "outbound email",
  "POST /api/email/subscriptions": "outbound email",
  "GET /api/email": "outbound email",
  "POST /api/email/test": "outbound email",
  "POST /api/email/brief": "outbound email",
  "GET /api/advisor/packets/:id": "file download",
  "POST /api/simplefin/connect": "bank credentials",
  "POST /api/simplefin/disconnect": "bank credentials",
  "GET /api/yearend/packet": "file download",
  "GET /api/household/outbound": "administration",
  "POST /api/household/outbound": "administration",
});

export const PARITY_PENDING = Object.freeze({
  "POST /api/import-proposals/:proposalId/review": {"ticket": "IMP-7", "operations": ["refresh.review_import"]},
  "POST /api/preferences/:id/delete": {"ticket": "C10", "operations": ["update_preferences.forget"]},
  "POST /api/recs/:id/answers": {"ticket": "C8", "operations": ["answer.rec_questions"]},
  "POST /api/recs/:id/start-over": {"ticket": "C9", "operations": ["act_on_recommendation.start_over"]},
  "POST /api/wargame/:name/pick": {"ticket": "C9", "operations": ["act_on_recommendation.pick_point"]},
  "POST /api/decisions/:id/decide": {"ticket": "C9", "operations": ["act_on_recommendation.decide"]},
  "POST /api/decisions/:id/revisit": {"ticket": "C9", "operations": ["act_on_recommendation.revisit"]},
  "POST /api/packs/:id/toggle": {"ticket": "C10", "operations": ["update_preferences.pack"]},
  "POST /api/your-plans/build": {"ticket": "C10", "operations": ["refresh.build_your_plans"]},
  "GET /api/accounts/:id": {"ticket": "C5", "operations": ["accounts.detail"]},
  "GET /api/pnl": {"ticket": "C4", "operations": ["business.pnl"]},
  "GET /api/pnl/rows": {"ticket": "C4", "operations": ["business.rows"]},
  "GET /api/spending": {"ticket": "C4", "operations": ["spending.total"]},
  "GET /api/spending/rows": {"ticket": "C4", "operations": ["transactions.search"]},
  "POST /api/accounts/:id/name": {"ticket": "C8", "operations": ["update_account.rename"]},
  "POST /api/accounts/:id/mask": {"ticket": "C8", "operations": ["update_account.mask"]},
  "POST /api/accounts/:id/owner": {"ticket": "C8", "operations": ["update_account.owner"]},
  "POST /api/accounts/:id/kind": {"ticket": "C8", "operations": ["update_account.kind"]},
  "GET /api/accounts/:id/merge-candidates": {"ticket": "C8", "operations": ["accounts.merge_candidates"]},
  "POST /api/accounts/:id/merge": {"ticket": "C8", "operations": ["update_account.merge"]},
  "GET /api/goals/suggestions": {"ticket": "C9", "operations": ["goals.suggestions"]},
  "POST /api/goals/:id/archive": {"ticket": "C9", "operations": ["update_goal.archive"]},
  "POST /api/goals/:id/delete": {"ticket": "C9", "operations": ["update_goal.delete"]},
  "POST /api/goals/:id/suggestion": {"ticket": "C9", "operations": ["update_goal.suggestion"]},
  "POST /api/curve": {"ticket": "C9", "operations": ["update_preferences.curve"]},
  "POST /api/onboarding/notes": {"ticket": "C10", "operations": ["refresh.import_file"]},
  "POST /api/files": {"ticket": "C10", "operations": ["refresh.import_file"]},
  "GET /api/files": {"ticket": "C10", "operations": ["household.imports"]},
  "POST /api/files/:id/retry": {"ticket": "C10", "operations": ["refresh.retry_import"]},
  "GET /api/confirm": {"ticket": "C8", "operations": ["household.confirm_items"]},
  "POST /api/confirm/list": {"ticket": "C8", "operations": ["household.confirm_items"]},
  "POST /api/confirm/answers": {"ticket": "C8", "operations": ["answer.confirm"]},
  "POST /api/confirm/reopen-many": {"ticket": "C8", "operations": ["answer.reopen"]},
  "GET /api/confirm/:id": {"ticket": "C8", "operations": ["household.confirm_items"]},
  "POST /api/confirm/:id/answer": {"ticket": "C8", "operations": ["answer.confirm"]},
  "POST /api/confirm/:id/reopen": {"ticket": "C8", "operations": ["answer.reopen"]},
  "GET /api/jobs": {"ticket": "C5", "operations": ["household.health"]},
  "POST /api/advisor/reviews": {"ticket": "C9", "operations": ["advisor_review.send"]},
  "POST /api/advisor/reviews/:id/verdict": {"ticket": "C9", "operations": ["advisor_review.verdict"]},
  "POST /api/advisor/checkin": {"ticket": "C9", "operations": ["advisor_review.checkin"]},
  "POST /api/advisor/packets": {"ticket": "C9", "operations": ["advisor_review.packet"]},
  "POST /api/jobs/:id/run": {"ticket": "C10", "operations": ["refresh.run_job"]},
  "POST /api/yearend/marks": {"ticket": "C8", "operations": ["answer.yearend_mark"]},
});

export function parityErrors(routes, registry, {
  excluded = PARITY_EXCLUDED, pending = PARITY_PENDING, strict = process.env.PARITY_STRICT === '1',
} = {}) {
  const router = new Set(routes.map(r => `${r.method} ${r.path}`));
  const declarations = new Map();
  const pairs = new Map();
  for (const tool of registry) for (const op of tool.operations) {
    const pair = `${tool.name}.${op.name}`;
    pairs.set(pair, new Set(op.routes));
    for (const route of op.routes) {
      if (!declarations.has(route)) declarations.set(route, []);
      declarations.get(route).push(pair);
    }
  }
  const errors = [];
  for (const route of router) {
    if (!declarations.has(route) && !Object.hasOwn(excluded, route) && !Object.hasOwn(pending, route)) errors.push(`uncovered route: ${route}`);
  }
  for (const route of Object.keys(excluded)) {
    if (declarations.has(route) || Object.hasOwn(pending, route)) errors.push(`excluded route also declared or pending: ${route}`);
  }
  for (const route of new Set([...declarations.keys(), ...Object.keys(excluded), ...Object.keys(pending)])) {
    if (!router.has(route)) errors.push(`route not in router: ${route}`);
  }
  for (const [route, entry] of Object.entries(pending)) for (const pair of entry.operations) {
    if (pairs.has(pair)) {
      if (!pairs.get(pair).has(route)) errors.push(`${pair} must declare ${route} (${entry.ticket})`);
    } else if (strict) errors.push(`${pair} not registered for ${route} (${entry.ticket})`);
  }
  return errors;
}
