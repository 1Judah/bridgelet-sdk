import './tracing.js';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { PinoLoggerService } from './common/logger/pino-logger.service.js';
import appConfig from './config/app.config.js';
import { validateEnv } from './config/env-validation.js';

async function bootstrap() {
  // #824: fail fast with one clear message listing every missing or invalid
  // required env var, before Nest tries to build the app or open a connection.
  validateEnv();

  const appCfg = appConfig();
  const isProduction = appCfg.env === 'production';
  const logger = isProduction ? new PinoLoggerService() : undefined;
  const app = await NestFactory.create(AppModule, { abortOnError: false });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: appCfg.corsOrigins,
    credentials: true,
  });

  const config = new DocumentBuilder()
    .setTitle('Bridgelet SDK API')
    .setDescription('Ephemeral account management API for Stellar')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = appCfg.port;
  void app.listen(port);

  const bootstrapLogger = new Logger('Bootstrap');
  bootstrapLogger.log(`Bridgelet SDK running on http://localhost:${port}`);
  bootstrapLogger.log(`API Documentation: http://localhost:${port}/api/docs`);
}

bootstrap().catch((err) => {
  console.error('BOOTSTRAP FAILED:', err?.stack ?? err);
  process.exit(1);
});
