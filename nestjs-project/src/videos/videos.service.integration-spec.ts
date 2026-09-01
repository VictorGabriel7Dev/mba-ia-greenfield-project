import { randomUUID } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';
import { VIDEO_QUEUE } from './videos.constants';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

async function putBytes(url: string, body: Buffer): Promise<string> {
  const view = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  const response = await fetch(url, {
    method: 'PUT',
    body: view as unknown as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`part upload failed with ${response.status}`);
  }
  const etag = response.headers.get('etag');
  if (!etag) throw new Error('storage returned no ETag');
  return etag;
}

describe('VideosService (integration, real database, MinIO and Redis)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let storage: ConfigType<typeof storageConfig>;
  let storageService: StorageService;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        ),
        BullModule.forRoot({
          connection: {
            host: process.env.QUEUE_HOST ?? 'redis',
            port: Number(process.env.QUEUE_PORT ?? 6379),
          },
        }),
        VideosModule,
      ],
    }).compile();

    service = moduleRef.get<VideosService>(VideosService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_QUEUE));
    storage = moduleRef.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
    storageService = moduleRef.get<StorageService>(StorageService);
  }, 60_000);

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const user = await dataSource.getRepository(User).save({
      email: `videos_svc_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'owner',
      nickname: `owner_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
  });

  const input = {
    title: 'A clip',
    filename: 'clip.mp4',
    contentType: 'video/mp4',
    sizeBytes: 2048,
  };

  describe('initiateUpload', () => {
    it('persists a draft with an open upload and a public identifier', async () => {
      const { video, parts } = await service.initiateUpload(
        channel.user_id,
        input,
      );

      const persisted = await videoRepository.findOneByOrFail({ id: video.id });
      expect(persisted.status).toBe(VideoStatus.DRAFT);
      expect(persisted.upload_id).toBeTruthy();
      expect(persisted.public_id).toMatch(/^[A-Za-z0-9_-]{12}$/);
      expect(parts).toHaveLength(1);
    }, 30_000);

    it('builds the storage key from the real channel and video ids', async () => {
      const { video } = await service.initiateUpload(channel.user_id, input);

      expect(video.storage_key).toBe(
        `channels/${channel.id}/videos/${video.id}/source.mp4`,
      );
    }, 30_000);

    it('gives two videos of the same channel different identifiers and keys', async () => {
      const first = await service.initiateUpload(channel.user_id, input);
      const second = await service.initiateUpload(channel.user_id, input);

      expect(first.video.public_id).not.toBe(second.video.public_id);
      expect(first.video.storage_key).not.toBe(second.video.storage_key);
    }, 30_000);
  });

  describe('completeUpload', () => {
    it('assembles the object, records the measured size and moves to processing', async () => {
      // The queue is paused so the real worker container, which consumes this
      // same queue, does not pick the job up and change the row underneath the
      // assertions.
      await queue.pause();
      try {
        const payload = Buffer.from('a'.repeat(2048));
        const { video, parts } = await service.initiateUpload(
          channel.user_id,
          input,
        );
        const etag = await putBytes(parts[0].url, payload);

        const completed = await service.completeUpload(
          channel.user_id,
          video.id,
          [{ partNumber: 1, etag }],
        );

        expect(completed.status).toBe(VideoStatus.PROCESSING);
        expect(completed.upload_id).toBeNull();
        // Declared 2048 and uploaded 2048; the point is that the value comes
        // from storage rather than from the request.
        expect(completed.size_bytes).toBe(payload.length);

        // The assembled object really exists in storage, at the right size.
        const head = await storageService.headObject(
          storage.videosBucket,
          completed.storage_key,
        );
        expect(head.contentLength).toBe(payload.length);
      } finally {
        await queue.resume();
      }
    }, 60_000);

    it('enqueues exactly one job, keyed by the video id, with the retry policy', async () => {
      await queue.pause();
      try {
        const { video, parts } = await service.initiateUpload(
          channel.user_id,
          input,
        );
        const etag = await putBytes(
          parts[0].url,
          Buffer.from('a'.repeat(2048)),
        );

        await service.completeUpload(channel.user_id, video.id, [
          { partNumber: 1, etag },
        ]);

        const job = await queue.getJob(video.id);
        expect(job).toBeDefined();
        expect(job!.name).toBe('process-video');
        expect(job!.data).toEqual({ videoId: video.id });
        expect(job!.opts.attempts).toBe(3);
        expect(job!.opts.backoff).toEqual({
          type: 'exponential',
          delay: 30_000,
        });
        // Failed jobs are the dead letter queue.
        expect(job!.opts.removeOnFail).toBe(false);

        await job!.remove();
      } finally {
        await queue.resume();
      }
    }, 60_000);
  });

  describe('abortUpload', () => {
    it('releases the upload and keeps the row as a draft', async () => {
      const { video, parts } = await service.initiateUpload(
        channel.user_id,
        input,
      );
      await putBytes(parts[0].url, Buffer.from('a'.repeat(2048)));

      await service.abortUpload(channel.user_id, video.id);

      const persisted = await videoRepository.findOneByOrFail({ id: video.id });
      expect(persisted.upload_id).toBeNull();
      expect(persisted.status).toBe(VideoStatus.DRAFT);

      // Completing an aborted upload must fail against real storage.
      await expect(
        service.completeUpload(channel.user_id, video.id, [
          { partNumber: 1, etag: '"x"' },
        ]),
      ).rejects.toThrow();
    }, 60_000);
  });

  describe('presigned URLs against the real storage', () => {
    it('signs playback URLs with the public endpoint host', async () => {
      const { video } = await service.initiateUpload(channel.user_id, input);
      await videoRepository.update(video.id, {
        status: VideoStatus.READY,
        thumbnail_key: `channels/${channel.id}/videos/${video.id}/thumbnail.jpg`,
      });

      const streamUrl = await service.buildStreamUrl(video.public_id);
      const downloadUrl = await service.buildDownloadUrl(video.public_id);
      const thumbnailUrl = await service.buildThumbnailUrl(video.public_id);

      for (const url of [streamUrl, downloadUrl, thumbnailUrl]) {
        expect(new URL(url).host).toBe(new URL(storage.publicEndpoint).host);
      }
      expect(downloadUrl).toContain('response-content-disposition');
    }, 30_000);
  });
});
