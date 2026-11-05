// Error type shared by the tool registry and the tools split into their own modules.

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}
