import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { requestContextMiddleware } from './common/request-context';
import { loadConfig } from './config/config';

async function bootstrap() {
  const cfg = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, bodyParser: true });
  app.set('trust proxy', 1);
  app.use(requestContextMiddleware);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.enableCors({ origin: [cfg.PUBLIC_WEB_URL, /\.gutad\.io$/, /localhost:\d+$/, /^exp:\/\//], credentials: true, allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Device-Token', 'X-Signature', 'X-Audit-Reason', 'X-Request-Id'] });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const doc = new DocumentBuilder().setTitle('Gutad API').setDescription('Restaurant commerce platform — ordering, delivery, reservations, events, shared kitchens, programs, settlement.').setVersion('1.0').addBearerAuth().build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc), { swaggerOptions: { persistAuthorization: true } });

  await app.listen(cfg.PORT, '0.0.0.0');
  new Logger('Bootstrap').log(`Gutad API listening on :${cfg.PORT} (payments=${cfg.PAYMENT_PROVIDER}, delivery=${cfg.DELIVERY_PROVIDER})`);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
