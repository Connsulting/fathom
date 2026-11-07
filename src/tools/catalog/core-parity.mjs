// Route coverage for write tools that already exist. The loader unions this with
// any later module. figures.mjs already declares the same routes after T1; both
// lists name tools that are in the registry today.
export const tools = [];

export const parity = {
  '/api/recs/:id/action': ['set_recommendation_status', 'set_recommendation_owner', 'set_recommendation_step'],
  '/api/goals': ['create_goal'],
  '/api/goals/:id': ['edit_goal'],
  '/api/preferences': ['remember_preference'],
  '/api/preferences/:id': ['remember_preference'],
  '/api/actions/:id/undo': ['undo_preference_action', 'undo_fact_action', 'undo_step_action', 'undo_goal_action', 'undo_recommendation_action'],
};
