export class DrovrError extends Error {
  constructor(
    message,
    { code = 3, outcome = "invalid_configuration", details } = {},
  ) {
    super(message);
    this.name = "DrovrError";
    this.code = code;
    this.outcome = outcome;
    this.details = details;
  }
}
