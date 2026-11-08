import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'InternalServerError';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') message = body;
      else if (body && typeof body === 'object') {
        const b = body as { message?: string | string[]; error?: string };
        message = b.message ?? exception.message;
        error = b.error ?? exception.name;
      }
    } else if (exception && typeof exception === 'object' && 'code' in exception) {
      // Postgres unique violation → 409 rather than 500
      const code = (exception as { code?: string }).code;
      if (code === '23505') {
        status = HttpStatus.CONFLICT;
        message = 'Duplicate record';
        error = 'Conflict';
      } else if (code === '22P02') {
        status = HttpStatus.BAD_REQUEST;
        message = 'Malformed identifier';
        error = 'BadRequest';
      } else if (code === '23503') {
        status = HttpStatus.BAD_REQUEST;
        message = 'Referenced record does not exist';
        error = 'BadRequest';
      }
    }

    if (status >= 500) this.log.error(`${req.method} ${req.url} → ${status}`, (exception as Error)?.stack);
    res.status(status).json({ statusCode: status, message, error, path: req.url, timestamp: new Date().toISOString() });
  }
}
