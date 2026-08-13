/** Error carrying an HTTP status code, surfaced verbatim to API clients. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): HttpError {
    return new HttpError(400, 'bad_request', message, details);
  }

  static notFound(message: string): HttpError {
    return new HttpError(404, 'not_found', message);
  }

  static conflict(message: string, details?: unknown): HttpError {
    return new HttpError(409, 'conflict', message, details);
  }

  static unprocessable(message: string, details?: unknown): HttpError {
    return new HttpError(422, 'unprocessable_entity', message, details);
  }
}

/** Failure of an external dependency (MiniCPM, yt-dlp, ffmpeg, storage). */
export class ExternalServiceError extends Error {
  readonly service: string;
  readonly retryable: boolean;

  constructor(service: string, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'ExternalServiceError';
    this.service = service;
    this.retryable = options?.retryable ?? true;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
