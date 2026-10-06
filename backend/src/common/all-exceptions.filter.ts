import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiError, ErrorBody, ErrorCode } from './api-error.js';

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'DEVICE_OFFLINE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/** Format unique { error: { code, message, details? } }, jamais de stack trace. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toBody(exception);
    if (status >= 500 && !(exception instanceof ApiError)) {
      this.logger.error(
        exception instanceof Error
          ? (exception.stack ?? exception.message)
          : String(exception),
      );
    }
    if (res.headersSent) return;
    res.status(status).json(body);
  }

  private toBody(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof ApiError) {
      return {
        status: exception.getStatus(),
        body: exception.getResponse() as ErrorBody,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code =
        CODE_BY_STATUS[status] ??
        (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR');
      // Erreurs Nest/Express (JSON mal formé, route inconnue...) : message générique.
      const message =
        status === 404
          ? 'Ressource introuvable'
          : status >= 500
            ? 'Erreur interne'
            : 'Requête invalide';
      return { status, body: { error: { code, message } } };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } },
    };
  }
}
