import { CallHandler, ExecutionContext, HttpException, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

/** One line per request: method, path, status, duration. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();
    const start = Date.now();
    return next.handle().pipe(
      tap({
        next: () => this.logger.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`),
        error: (err) => {
          const status = err instanceof HttpException ? err.getStatus() : 500;
          this.logger.log(`${req.method} ${req.originalUrl} ${status} ${Date.now() - start}ms`);
        },
      }),
    );
  }
}
