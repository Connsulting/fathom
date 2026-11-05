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
