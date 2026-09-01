import { Test } from '@nestjs/testing';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { User } from '../users/entities/user.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('should compile with its entity, queue, storage and channel dependencies', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        ),
        // registerQueue inside VideosModule needs the shared connection that
        // forRoot provides; without it the queue provider cannot be resolved.
        BullModule.forRoot({
          connection: {
            host: process.env.QUEUE_HOST ?? 'redis',
            port: Number(process.env.QUEUE_PORT ?? 6379),
          },
        }),
        VideosModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
