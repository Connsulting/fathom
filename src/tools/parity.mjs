const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const reason = {
  identity: 'Identity stays with the person, and the agent never signs in, registers, recovers, signs out or manages passkeys.',
  admin: 'Administration of who can see the household is not delegated to a key.',
  keys: 'A key must never mint or widen keys.',
  email: 'The agent never sends email or takes an action that leaves the product.',
  bank: 'Bank credential handling stays with the person.',
  engine: 'The agent never turns itself on or raises its own budget.',
  demo: 'Resetting the demo is demo-only and destructive.',
  whatif: 'A pack what-if is itself an Ask answer, and the agent answers what-ifs with the tools.',
  chrome: 'Threads and Ask are conversation chrome, and an MCP client keeps its own conversations.',
  onboarding: 'The onboarding step route is first-run sequencing for the wizard.',
};

export const PARITY_EXCLUDED = Object.freeze({
  '/api/auth/register/options': reason.identity,
  '/api/auth/register/verify': reason.identity,
  '/api/auth/signin/options': reason.identity,
  '/api/auth/signin/verify': reason.identity,
  '/api/auth/recover': reason.identity,
  '/api/auth/signout': reason.identity,
  '/api/auth/passkeys/link': reason.identity,
  '/api/auth/passkeys/:id/revoke': reason.identity,
  '/api/admin/users/invite': reason.admin,
  '/api/admin/users/:id/role': reason.admin,
  '/api/admin/users/:id/remove': reason.admin,
  '/api/admin/users/:id/passkeys/:keyId/revoke': reason.admin,
  '/api/auth/invitations/accept': reason.admin,
  '/api/operator/households': reason.admin,
  '/api/packs/:id/whatif': reason.whatif,
  '/api/engine': reason.engine,
  '/api/engine/cap': reason.engine,
  '/api/ask': reason.chrome,
  '/api/threads': reason.chrome,
  '/api/threads/:id/rename': reason.chrome,
  '/api/threads/:id/archive': reason.chrome,
  '/api/threads/:id/trash': reason.chrome,
  '/api/threads/:id/restore': reason.chrome,
  '/api/threads/:id/delete': reason.chrome,
  '/api/onboarding': reason.onboarding,
  '/api/demo/reset': reason.demo,
  '/api/keys': reason.keys,
  '/api/keys/:id/revoke': reason.keys,
  '/api/email/test': reason.email,
  '/api/email/brief': reason.email,
  '/api/simplefin/connect': reason.bank,
  '/api/simplefin/disconnect': reason.bank,
});

function later(tools, owner) {
  return Object.freeze({ tools: Object.freeze([...tools]), owner });
}

export const PARITY_PENDING = Object.freeze({
  '/api/recs/:id/answers': later(['answer_recommendation_questions'], 'T22'),
  '/api/recs/:id/start-over': later(['start_recommendation_over'], 'T22'),
  '/api/wargame/:name/pick': later(['pick_wargame_point'], 'T22'),
  '/api/decisions/:id/decide': later(['decide_decision'], 'T22'),
  '/api/decisions/:id/revisit': later(['revisit_decision'], 'T22'),
  '/api/packs/:id/toggle': later(['set_pack_active'], 'T22'),
  '/api/your-plans/build': later(['build_your_plans'], 'T26'),
  '/api/accounts/:id/name': later(['rename_account'], 'T27'),
  '/api/accounts/:id/mask': later(['set_account_mask'], 'T27'),
  '/api/accounts/:id/owner': later(['set_account_owner'], 'T27'),
  '/api/accounts/:id/kind': later(['set_account_kind'], 'T27'),
  '/api/accounts/:id/merge': later(['merge_accounts'], 'T27'),
  '/api/goals/:id/archive': later(['archive_goal'], 'T23'),
  '/api/goals/:id/delete': later(['delete_goal'], 'T23'),
  '/api/goals/:id/suggestion': later(['set_goal_suggestion'], 'T23'),
  '/api/curve': later(['set_curve_position'], 'T23'),
  '/api/onboarding/notes': later(['import_file'], 'T26'),
  '/api/files': later(['import_file'], 'T26'),
  '/api/files/:id/retry': later(['retry_import'], 'T26'),
  '/api/confirm/list': later(['list_confirm_items'], 'T25'),
  '/api/confirm/answers': later(['answer_confirm_item'], 'T25'),
  '/api/confirm/reopen-many': later(['reopen_confirm_item'], 'T25'),
  '/api/confirm/:id/answer': later(['answer_confirm_item'], 'T25'),
  '/api/confirm/:id/reopen': later(['reopen_confirm_item'], 'T25'),
  '/api/advisor/reviews': later(['send_to_advisor'], 'T24'),
  '/api/advisor/reviews/:id/verdict': later(['record_advisor_verdict'], 'T24'),
  '/api/advisor/checkin': later(['set_advisor_checkin'], 'T24'),
  '/api/advisor/packets': later(['create_review_packet'], 'T24'),
  '/api/jobs/:id/run': later(['run_job'], 'T26'),
  '/api/yearend/marks': later(['mark_yearend_item'], 'T24'),
  '/api/preferences/:id/delete': later(['forget_preference'], 'T18'),
});

export function checkParity({ routes, toolNames, declared, excluded, pending, strict = false }) {
  const errors = [];
  const paths = new Set(routes.map(route => route.path));
  for (const route of routes) {
    if (!MUTATING.has(route.method)) continue;
    if (!declared[route.path] && !Object.hasOwn(excluded, route.path) && !pending[route.path]) {
      errors.push(`uncovered ${route.method} ${route.path}`);
    }
  }
  for (const path of Object.keys(excluded)) {
    if (declared[path] || pending[path]) errors.push(`excluded and listed ${path}`);
    if (!paths.has(path)) errors.push(`excluded route not in router ${path}`);
  }
  for (const [path, toolList] of Object.entries(declared)) {
    if (!paths.has(path)) errors.push(`declared route not in router ${path}`);
    for (const name of toolList) {
      if (!toolNames.has(name)) errors.push(`declared tool absent ${name}`);
    }
  }
  if (strict) {
    for (const entry of Object.values(pending)) {
      for (const name of entry.tools) {
        if (!toolNames.has(name)) errors.push(`pending tool absent ${name}`);
      }
    }
  }
  return errors;
}
