export class LitenvError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 1,
  ) {
    super(message);
    this.name = "LitenvError";
  }
}

export class UsageError extends LitenvError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}
