import { undoAdoption } from '../goals/write.mjs';
import { ToolError } from '../tools/errors.mjs';

export function setGoalSuggestion(db, id, body, { now, onWrite } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.action !== 'undo' || Object.keys(body).length !== 1) {
    throw new ToolError('bad_input', "send {action: 'undo'}");
  }
  return undoAdoption(db, id, { now, onWrite });
}
