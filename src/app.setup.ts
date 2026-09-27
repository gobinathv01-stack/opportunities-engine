import { INestApplication, ValidationPipe } from '@nestjs/common';
import { LoggingInterceptor } from './common/logging.interceptor';

export function configureApp(app: INestApplication) {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalInterceptors(new LoggingInterceptor());
}
