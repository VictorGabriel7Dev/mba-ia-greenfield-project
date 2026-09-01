import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { User } from '../users/entities/user.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('should compile with TypeOrmModule.forFeature([Video]) and its dependencies', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        ),
        VideosModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
