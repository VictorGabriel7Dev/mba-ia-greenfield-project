import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { UsersModule } from '../users/users.module';
import appConfig from '../config/app.config';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VIDEO_QUEUE } from './videos.constants';

/**
 * Module graph for the worker process.
 *
 * Deliberately narrower than AppModule: no controllers, no HTTP layer, no
 * auth. The worker consumes a queue and writes to the database and to storage,
 * and nothing else.
 *
 * The env schema is not applied here: the worker shares the `.env` of the API
 * and is validated by the same schema at the API's boot. Re-validating would
 * demand JWT and mail variables that this process never reads.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        databaseConfig,
        storageConfig,
        queueConfig,
        videoConfig,
      ],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres' as const,
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video]),
    // Video relates to Channel, and Channel to User. TypeORM builds the whole
    // relation graph at startup, so an entity that is only the far side of a
    // relation still has to be registered: without these two the worker dies
    // with "Entity metadata for Video#channel was not found". They come in
    // through their owning modules rather than a bare forFeature, so the
    // entities stay owned where they belong.
    ChannelsModule,
    UsersModule,
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: { host: cfg.host, port: cfg.port },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_QUEUE }),
    StorageModule,
  ],
  providers: [FfmpegService, VideoProcessingProcessor],
})
export class WorkerModule {}
