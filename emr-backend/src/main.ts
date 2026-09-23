import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.set('trust proxy', 'loopback');   // reverse proxy-ს მიღმა რეალური client IP აუდიტისთვის
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');
  Logger.log(`EMR API: http://0.0.0.0:${env.PORT}/api (${env.NODE_ENV})`, 'Bootstrap');
}
bootstrap();
