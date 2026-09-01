import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { Video } from './video.entity';
import { VideoStatus } from '../video-status.enum';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel, Video], {
      synchronize: false,
    });
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const user = await dataSource.getRepository(User).save({
      email: `owner-${randomUUID()}@streamtube.local`,
      password: 'hash',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'owner',
      nickname: `owner_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
  });

  function build(overrides: Partial<Video> = {}): Partial<Video> {
    return {
      public_id: randomUUID().slice(0, 12),
      channel_id: channel.id,
      title: 'A clip',
      storage_key: `channels/${channel.id}/videos/x/source.mp4`,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      ...overrides,
    };
  }

  it('defaults status to draft', async () => {
    const saved = await videos.save(videos.create(build()));

    const reloaded = await videos.findOneByOrFail({ id: saved.id });
    expect(reloaded.status).toBe(VideoStatus.DRAFT);
  });

  it('rejects a duplicate public_id', async () => {
    const publicId = randomUUID().slice(0, 12);
    await videos.save(videos.create(build({ public_id: publicId })));

    await expect(
      videos.save(videos.create(build({ public_id: publicId }))),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('rejects a channel_id that does not exist', async () => {
    await expect(
      videos.save(videos.create(build({ channel_id: randomUUID() }))),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('rejects a status outside the enum', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO "videos"
           (public_id, channel_id, title, status, storage_key, original_filename, content_type)
         VALUES ($1, $2, 'x', 'transcoding', 'k', 'f.mp4', 'video/mp4')`,
        [randomUUID().slice(0, 12), channel.id],
      ),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('round-trips size_bytes above 2^32 as a number, not a string', async () => {
    // TypeORM returns bigint columns as strings. Without the transformer the
    // value comes back as "10737418240" and every numeric comparison against
    // it silently becomes a string comparison.
    const tenGiB = 10737418240;
    const saved = await videos.save(
      videos.create(build({ size_bytes: tenGiB })),
    );

    const reloaded = await videos.findOneByOrFail({ id: saved.id });
    expect(typeof reloaded.size_bytes).toBe('number');
    expect(reloaded.size_bytes).toBe(tenGiB);
  });

  it('round-trips duration_seconds as a number with sub-second precision', async () => {
    // numeric columns have the same string problem as bigint.
    const saved = await videos.save(
      videos.create(build({ duration_seconds: 12.345 })),
    );

    const reloaded = await videos.findOneByOrFail({ id: saved.id });
    expect(typeof reloaded.duration_seconds).toBe('number');
    expect(reloaded.duration_seconds).toBeCloseTo(12.345, 3);
  });

  it('stores and reads back structured metadata', async () => {
    const saved = await videos.save(
      videos.create(
        build({
          metadata: {
            width: 1920,
            height: 1080,
            videoCodec: 'h264',
            bitRate: 4_500_000,
          },
        }),
      ),
    );

    const reloaded = await videos.findOneByOrFail({ id: saved.id });
    expect(reloaded.metadata).toEqual({
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      bitRate: 4_500_000,
    });
  });

  it('leaves the worker-owned columns null until processing runs', async () => {
    const saved = await videos.save(videos.create(build()));

    const reloaded = await videos.findOneByOrFail({ id: saved.id });
    expect(reloaded.thumbnail_key).toBeNull();
    expect(reloaded.duration_seconds).toBeNull();
    expect(reloaded.metadata).toBeNull();
    expect(reloaded.processing_error).toBeNull();
  });

  it('loads the owning channel through the relation', async () => {
    const saved = await videos.save(videos.create(build()));

    const reloaded = await videos.findOneOrFail({
      where: { id: saved.id },
      relations: ['channel'],
    });
    expect(reloaded.channel.id).toBe(channel.id);
  });

  it('populates created_at and updated_at automatically', async () => {
    const saved = await videos.save(videos.create(build()));

    const reloaded = await videos.findOneByOrFail({ id: saved.id });
    expect(reloaded.created_at).toBeInstanceOf(Date);
    expect(reloaded.updated_at).toBeInstanceOf(Date);
  });
});
