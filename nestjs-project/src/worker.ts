import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './videos/worker.module';

/**
 * Entry point of the video worker.
 *
 * A standalone application context, not an HTTP server: this process consumes
 * the `video-processing` queue and has no routes. It reuses the project's
 * modules, config and TypeORM setup without starting anything it does not
 * need.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('VideoWorker');
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: false,
  });

  app.enableShutdownHooks();

  const shutdown = (signal: string): void => {
    logger.log(`${signal} received, closing the worker`);
    // Closing the context lets BullMQ finish the job in flight and release the
    // database and Redis connections, instead of dropping them mid-write.
    void app.close().then(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.log('Video worker started, consuming video-processing');
}

void bootstrap();
