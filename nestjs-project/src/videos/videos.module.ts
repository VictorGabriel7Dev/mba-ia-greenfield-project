import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';

@Module({
  // `autoLoadEntities` alone does not discover Video: an entity is only
  // registered if some module imports it through forFeature. Forgetting this
  // produces no clear error, only a repository that cannot be injected and an
  // entity silently absent from generated migrations.
  imports: [TypeOrmModule.forFeature([Video]), ChannelsModule, StorageModule],
  exports: [TypeOrmModule],
})
export class VideosModule {}
