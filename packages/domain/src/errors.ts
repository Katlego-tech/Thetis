export type DomainErrorCode =
  | "INVALID_INTEGER"
  | "NEGATIVE"
  | "OVERFLOW"
  | "INVALID_BPS"
  | "SOLD_EXCEEDS_LOCKED";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string = code) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
