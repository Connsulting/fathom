export class EngineOffError extends Error {
  constructor() { super('The model engine is off'); this.name = 'EngineOffError'; }
}

export class BudgetExceededError extends Error {
  constructor() { super('Monthly model budget has been reached'); this.name = 'BudgetExceededError'; }
}

export class RoundLimitError extends Error {
  constructor() { super('Model round limit reached'); this.name = 'RoundLimitError'; }
}

export class ModelCallError extends Error {
  constructor(message = 'Model call failed') { super(message); this.name = 'ModelCallError'; }
}

export class ModelAccountingError extends Error {
  constructor() { super('Model cost is incomplete; this engine refuses further calls'); this.name = 'ModelAccountingError'; }
}

// A live round the instance does not fund (no instance model cap).
export function fundingUnavailable() {
  const error = new ModelCallError('Model calls are not funded on this instance');
  error.code = 'funding_unavailable';
  return error;
}

// An engine refusal carrying a fixed code (household_unavailable, authorization_revoked, accounting_hold).
export function withCode(error, code) {
  error.code = code;
  return error;
}
