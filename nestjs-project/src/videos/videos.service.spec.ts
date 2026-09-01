import { QueryFailedError } from 'typeorm';
import {
  ChannelNotFoundException,
  FileTooLargeException,
  InvalidVideoStateException,
  ThumbnailNotAvailableException,
  UnsupportedContentTypeException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from '../common/exceptions/domain.exception';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';

const TEN_GIB = 10_737_418_240;
const HUNDRED_MIB = 104_857_600;
const CHANNEL_ID = 'channel-uuid';
const USER_ID = 'user-uuid';

const storageCfg = {
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://storage.streamtube.local:9000',
  region: 'us-east-1',
  accessKey: 'k',
  secretKey: 's',
  videosBucket: 'streamtube-videos',
  thumbnailsBucket: 'streamtube-thumbnails',
};

const videoCfg = {
  maxSizeBytes: TEN_GIB,
  partSizeBytes: HUNDRED_MIB,
  uploadUrlTtlSeconds: 3600,
  playbackUrlTtlSeconds: 900,
  processingUrlTtlSeconds: 7200,
  allowedContentTypes: ['video/mp4', 'video/quicktime'],
};

interface Mocks {
  repository: {
    save: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
  };
  channels: { findByUserId: jest.Mock };
  storage: {
    createMultipartUpload: jest.Mock;
    presignUploadParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    presignGet: jest.Mock;
    presignInternalGet: jest.Mock;
    putObject: jest.Mock;
  };
  queue: { add: jest.Mock };
}

function makeChannel(): Channel {
  const channel = new Channel();
  channel.id = CHANNEL_ID;
  channel.nickname = 'owner';
  channel.name = 'owner';
  return channel;
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  const video = new Video();
  video.id = 'video-uuid';
  video.public_id = 'Ab3dEf6hIj9k';
  video.channel_id = CHANNEL_ID;
  video.title = 'A clip';
  video.status = VideoStatus.DRAFT;
  video.storage_key = `channels/${CHANNEL_ID}/videos/video-uuid/source.mp4`;
  video.thumbnail_key = null;
  video.original_filename = 'clip.mp4';
  video.content_type = 'video/mp4';
  video.size_bytes = 1024;
  video.duration_seconds = null;
  video.metadata = null;
  video.upload_id = 'upload-1';
  video.processing_error = null;
  video.created_at = new Date();
  video.updated_at = new Date();
  return Object.assign(video, overrides);
}

function build(): { service: VideosService; mocks: Mocks } {
  const mocks: Mocks = {
    repository: {
      save: jest.fn((entity: Video) => Promise.resolve(entity)),
      create: jest.fn((data: Partial<Video>) =>
        Object.assign(new Video(), data),
      ),
      findOne: jest.fn(),
    },
    channels: { findByUserId: jest.fn().mockResolvedValue(makeChannel()) },
    storage: {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignUploadParts: jest.fn().mockResolvedValue([]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ contentLength: 2048 }),
      presignGet: jest.fn().mockResolvedValue('https://signed/get'),
      presignInternalGet: jest.fn().mockResolvedValue('https://signed/internal'),
      putObject: jest.fn().mockResolvedValue(undefined),
    },
    queue: { add: jest.fn().mockResolvedValue(undefined) },
  };

  const service = new VideosService(
    mocks.repository as never,
    mocks.channels as never,
    mocks.storage as never,
    mocks.queue as never,
    storageCfg,
    videoCfg,
  );

  return { service, mocks };
}

const validInput = {
  title: 'A clip',
  filename: 'clip.mp4',
  contentType: 'video/mp4',
  sizeBytes: 1024,
};

describe('VideosService', () => {
  describe('initiateUpload — part arithmetic', () => {
    it.each([
      ['exactly one part', HUNDRED_MIB, 1],
      ['one byte over one part', HUNDRED_MIB + 1, 2],
      ['one byte under one part', HUNDRED_MIB - 1, 1],
      ['a single byte', 1, 1],
      ['the full 10 GiB maximum', TEN_GIB, 103],
    ])('requests %s', async (_label, sizeBytes, expectedParts) => {
      const { service, mocks } = build();

      await service.initiateUpload(USER_ID, { ...validInput, sizeBytes });

      expect(mocks.storage.presignUploadParts).toHaveBeenCalledWith(
        storageCfg.videosBucket,
        expect.any(String),
        'upload-1',
        expectedParts,
        videoCfg.uploadUrlTtlSeconds,
      );
    });

    it('stays well below the 10000-part ceiling at the maximum size', async () => {
      const { service, mocks } = build();

      await service.initiateUpload(USER_ID, {
        ...validInput,
        sizeBytes: TEN_GIB,
      });

      const partCount = mocks.storage.presignUploadParts.mock
        .calls[0][3] as number;
      expect(partCount).toBeLessThan(10000);
    });
  });

  describe('initiateUpload — validation', () => {
    it('rejects a size above the configured maximum', async () => {
      const { service, mocks } = build();

      await expect(
        service.initiateUpload(USER_ID, {
          ...validInput,
          sizeBytes: TEN_GIB + 1,
        }),
      ).rejects.toBeInstanceOf(FileTooLargeException);
      // Nothing must be opened in storage for a request that is rejected.
      expect(mocks.storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('accepts a size exactly at the maximum', async () => {
      const { service } = build();

      await expect(
        service.initiateUpload(USER_ID, { ...validInput, sizeBytes: TEN_GIB }),
      ).resolves.toBeDefined();
    });

    it('rejects a content type outside the allowlist', async () => {
      const { service } = build();

      await expect(
        service.initiateUpload(USER_ID, {
          ...validInput,
          contentType: 'application/zip',
        }),
      ).rejects.toBeInstanceOf(UnsupportedContentTypeException);
    });

    it('matches the allowlist case-insensitively', async () => {
      const { service } = build();

      await expect(
        service.initiateUpload(USER_ID, {
          ...validInput,
          contentType: 'VIDEO/MP4',
        }),
      ).resolves.toBeDefined();
    });

    it('rejects when the user has no channel', async () => {
      const { service, mocks } = build();
      mocks.channels.findByUserId.mockResolvedValue(null);

      await expect(
        service.initiateUpload(USER_ID, validInput),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);
    });
  });

  describe('initiateUpload — persistence', () => {
    it('persists the video as a draft owned by the caller channel', async () => {
      const { service, mocks } = build();

      const result = await service.initiateUpload(USER_ID, validInput);

      expect(result.video.status).toBe(VideoStatus.DRAFT);
      expect(result.video.channel_id).toBe(CHANNEL_ID);
      expect(result.video.upload_id).toBe('upload-1');
      expect(result.video.public_id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    });

    it('derives the storage key from the channel and video ids, not the title', async () => {
      const { service } = build();

      const result = await service.initiateUpload(USER_ID, {
        ...validInput,
        title: 'A title that will be edited later',
      });

      expect(result.video.storage_key).toBe(
        `channels/${CHANNEL_ID}/videos/${result.video.id}/source.mp4`,
      );
    });

    it('aborts the multipart upload when the row cannot be written', async () => {
      // An initiated upload never expires on its own, so a row we failed to
      // write would leave parts accumulating with nothing pointing at them.
      const { service, mocks } = build();
      mocks.repository.save.mockRejectedValue(new Error('db is down'));

      await expect(service.initiateUpload(USER_ID, validInput)).rejects.toThrow(
        'db is down',
      );
      expect(mocks.storage.abortMultipartUpload).toHaveBeenCalledWith(
        storageCfg.videosBucket,
        expect.any(String),
        'upload-1',
      );
    });

    it('retries with a new public_id on a unique violation', async () => {
      const { service, mocks } = build();
      const collision = new QueryFailedError('INSERT', [], new Error());
      Object.assign(collision, {
        code: '23505',
        detail: 'Key (public_id)=(abc) already exists.',
      });
      mocks.repository.save
        .mockRejectedValueOnce(collision)
        .mockImplementation((entity: Video) => Promise.resolve(entity));

      const result = await service.initiateUpload(USER_ID, validInput);

      expect(mocks.repository.save).toHaveBeenCalledTimes(2);
      const first = mocks.repository.save.mock.calls[0][0] as Video;
      const second = mocks.repository.save.mock.calls[1][0] as Video;
      expect(first.public_id).not.toBe(second.public_id);
      expect(result.video.public_id).toBe(second.public_id);
    });

    it('rethrows a unique violation on another column instead of retrying', async () => {
      const { service, mocks } = build();
      const other = new QueryFailedError('INSERT', [], new Error());
      Object.assign(other, {
        code: '23505',
        detail: 'Key (storage_key)=(x) already exists.',
      });
      mocks.repository.save.mockRejectedValue(other);

      await expect(service.initiateUpload(USER_ID, validInput)).rejects.toBe(
        other,
      );
      expect(mocks.repository.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('completeUpload', () => {
    const parts = [{ partNumber: 1, etag: 'e1' }];

    it('assembles, records the measured size and moves to processing', async () => {
      const { service, mocks } = build();
      mocks.repository.findOne.mockResolvedValue(makeVideo());

      const result = await service.completeUpload(USER_ID, 'video-uuid', parts);

      expect(mocks.storage.completeMultipartUpload).toHaveBeenCalled();
      expect(result.status).toBe(VideoStatus.PROCESSING);
      // The declared size was 1024; storage measured 2048. The measurement wins.
      expect(result.size_bytes).toBe(2048);
      expect(result.upload_id).toBeNull();
    });

    it('enqueues one job keyed by the video id', async () => {
      const { service, mocks } = build();
      mocks.repository.findOne.mockResolvedValue(makeVideo());

      await service.completeUpload(USER_ID, 'video-uuid', parts);

      expect(mocks.queue.add).toHaveBeenCalledTimes(1);
      const [jobName, payload, options] = mocks.queue.add.mock.calls[0] as [
        string,
        { videoId: string },
        { jobId: string; attempts: number; removeOnFail: boolean },
      ];
      expect(jobName).toBe('process-video');
      expect(payload).toEqual({ videoId: 'video-uuid' });
      // jobId equal to the video id makes a duplicated completion idempotent.
      expect(options.jobId).toBe('video-uuid');
      expect(options.attempts).toBe(3);
      // Failed jobs are the dead letter queue; removing them deletes the
      // evidence of the failure.
      expect(options.removeOnFail).toBe(false);
    });

    it('rejects a video owned by another channel', async () => {
      const { service, mocks } = build();
      mocks.repository.findOne.mockResolvedValue(
        makeVideo({ channel_id: 'someone-else' }),
      );

      await expect(
        service.completeUpload(USER_ID, 'video-uuid', parts),
      ).rejects.toBeInstanceOf(VideoNotOwnedException);
      expect(mocks.storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('rejects an unknown video', async () => {
      const { service, mocks } = build();
      mocks.repository.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER_ID, 'missing', parts),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'rejects completing a video already in %s',
      async (status) => {
        const { service, mocks } = build();
        mocks.repository.findOne.mockResolvedValue(makeVideo({ status }));

        await expect(
          service.completeUpload(USER_ID, 'video-uuid', parts),
        ).rejects.toBeInstanceOf(InvalidVideoStateException);
        expect(mocks.queue.add).not.toHaveBeenCalled();
      },
    );

    it('rejects completing a draft with no open upload', async () => {
      const { service, mocks } = build();
      mocks.repository.findOne.mockResolvedValue(makeVideo({ upload_id: null }));

      await expect(
        service.completeUpload(USER_ID, 'video-uuid', parts),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
    });
  });

  describe('abortUpload', () => {
    it('releases the parts and keeps the row as a draft', async () => {
      const { service, mocks } = build();
      const video = makeVideo();
      mocks.repository.findOne.mockResolvedValue(video);

      await service.abortUpload(USER_ID, 'video-uuid');

      expect(mocks.storage.abortMultipartUpload).toHaveBeenCalledWith(
        storageCfg.videosBucket,
        video.storage_key,
        'upload-1',
      );
      const saved = mocks.repository.save.mock.calls[0][0] as Video;
      expect(saved.upload_id).toBeNull();
      expect(saved.status).toBe(VideoStatus.DRAFT);
    });

    it('rejects aborting when there is no open upload', async () => {
      const { service, mocks } = build();
      mocks.repository.findOne.mockResolvedValue(makeVideo({ upload_id: null }));

      await expect(
        service.abortUpload(USER_ID, 'video-uuid'),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
    });
  });

  describe('findPublicByPublicId', () => {
    it('reports a video that is not ready as not found', async () => {
      // Absence and not-being-ready must be indistinguishable from outside,
      // otherwise a draft can be detected by probing public identifiers.
      const { service, mocks } = build();
      mocks.repository.findOne.mockResolvedValue(null);

      await expect(
        service.findPublicByPublicId('Ab3dEf6hIj9k'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('queries filtered by ready status, not by identifier alone', async () => {
      const { service, mocks } = build();
      mocks.repository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY }),
      );

      await service.findPublicByPublicId('Ab3dEf6hIj9k');

      const query = mocks.repository.findOne.mock.calls[0][0] as {
        where: { public_id: string; status: VideoStatus };
      };
      expect(query.where.status).toBe(VideoStatus.READY);
    });
  });

  describe('playback URLs', () => {
    beforeEach(() => jest.clearAllMocks());

    it('signs the stream URL with the playback TTL', async () => {
      const { service, mocks } = build();
      mocks.repository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY }),
      );

      await service.buildStreamUrl('Ab3dEf6hIj9k');

      expect(mocks.storage.presignGet).toHaveBeenCalledWith(
        storageCfg.videosBucket,
        expect.any(String),
        videoCfg.playbackUrlTtlSeconds,
      );
    });

    it('sets an attachment disposition for downloads', async () => {
      const { service, mocks } = build();
      mocks.repository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY }),
      );

      await service.buildDownloadUrl('Ab3dEf6hIj9k');

      const options = mocks.storage.presignGet.mock.calls[0][3] as {
        contentDisposition: string;
      };
      expect(options.contentDisposition).toBe(
        'attachment; filename="clip.mp4"',
      );
    });

    it('strips quotes and newlines from the filename in the header', async () => {
      // An unescaped quote or newline terminates the header value early, which
      // is response splitting rather than a cosmetic issue.
      const { service, mocks } = build();
      mocks.repository.findOne.mockResolvedValue(
        makeVideo({
          status: VideoStatus.READY,
          original_filename: 'a"b\r\nX-Injected: 1.mp4',
        }),
      );

      await service.buildDownloadUrl('Ab3dEf6hIj9k');

      const options = mocks.storage.presignGet.mock.calls[0][3] as {
        contentDisposition: string;
      };
      expect(options.contentDisposition).not.toContain('"b');
      expect(options.contentDisposition).not.toContain('\r');
      expect(options.contentDisposition).not.toContain('\n');
    });

    it('reports a missing thumbnail distinctly from a missing video', async () => {
      const { service, mocks } = build();
      mocks.repository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY, thumbnail_key: null }),
      );

      await expect(
        service.buildThumbnailUrl('Ab3dEf6hIj9k'),
      ).rejects.toBeInstanceOf(ThumbnailNotAvailableException);
    });
  });
});
