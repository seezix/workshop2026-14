import { HttpException, HttpStatus } from '@nestjs/common';

// Codes d'erreur du contrat (GUIDELINES §6.5).
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'DEVICE_OFFLINE'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: HttpStatus.BAD_REQUEST,
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  DEVICE_OFFLINE: HttpStatus.CONFLICT,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  SERVICE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  INTERNAL_ERROR: HttpStatus.INTERNAL_SERVER_ERROR,
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown[] };
}

export class ApiError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown[],
  ) {
    const body: ErrorBody = {
      error: { code, message, ...(details ? { details } : {}) },
    };
    super(body, STATUS[code]);
  }

  static notFound(what: string) {
    return new ApiError('NOT_FOUND', `${what} introuvable`);
  }
}
