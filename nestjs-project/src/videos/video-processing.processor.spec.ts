import { Job } from 'bullmq';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import {
  ProcessVideoJobData,
  VideoProcessingProcessor,
} from './video-processing.processor';

const CHANNEL_ID = 'channel-uuid';
const VIDEO_ID = 'video-uuid';

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
  maxSizeBytes: 10_737_418_240,
  partSizeBytes: 104_857_600,
  uploadUrlTtlSeconds: 3600,
  playbackUrlTtlSeconds: 900,
  processingUrlTtlSeconds: 7200,
  allowedContentTypes: ['video/mp4'],
};

function makeVideo(overrides: Partial<Video> = {}): Video {
  const video = new Video();
  video.id = VIDEO_ID;
  video.public_id = 'Ab3dEf6hIj9k';
  video.channel_id = CHANNEL_ID;
  video.title = 'A clip';
  video.status = VideoStatus.PROCESSING;
  video.storage_key = `channels/${CHANNEL_ID}/videos/${VIDEO_ID}/source.mp4`;
  video.thumbnail_key = null;
  video.original_filename = 'clip.mp4';
  video.content_type = 'video/mp4';
  video.size_bytes = 47210;
  video.duration_seconds = null;
  video.metadata = null;
  video.upload_id = null;
  video.processing_error = null;
  return Object.assign(video, overrides);
}

function makeJob(attemptsMade = 0, attempts = 3): Job<ProcessVideoJobData> {
  return {
    id: 'job-1',
    data: { videoId: VIDEO_ID },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<ProcessVideoJobData>;
}

function build(video: Video | null = makeVideo()) {
  const repository = {
    findOne: jest.fn().mockResolvedValue(video),
    save: jest.fn((entity: Video) => Promise.resolve(entity)),
  };
  const storage = {
    presignInternalGet: jest.fn().mockResolvedValue('http://minio:9000/signed'),
    presignGet: jest.fn().mockResolvedValue('http://public/signed'),
    putObject: jest.fn().mockResolvedValue(undefined),
  };
  const ffmpeg = {
    probe: jest.fn().mockResolvedValue({
      durationSeconds: 2,
      metadata: { width: 320, height: 240, videoCodec: 'h264' },
    }),
    thumbnailTimestamp: jest.fn().mockReturnValue(0.5),
    extractThumbnail: jest
      .fn()
      .mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff])),
  };

  const processor = new VideoProcessingProcessor(
    repository as never,
    storage as never,
    ffmpeg as never,
    storageCfg,
    videoCfg,
  );

  return { processor, repository, storage, ffmpeg };
}

describe('VideoProcessingProcessor', () => {
  describe('happy path', () => {
    it('writes duration, metadata and thumbnail key, and marks the video ready', async () => {
      const { processor, repository } = build();

      await processor.process(makeJob());

      const saved = repository.save.mock.calls[0][0];
      expect(saved.status).toBe(VideoStatus.READY);
      expect(saved.duration_seconds).toBe(2);
      expect(saved.metadata).toEqual({
        width: 320,
        height: 240,
        videoCodec: 'h264',
      });
      expect(saved.thumbnail_key).toBe(
        `channels/${CHANNEL_ID}/videos/${VIDEO_ID}/thumbnail.jpg`,
      );
      expect(saved.processing_error).toBeNull();
    });

    it('hands FFmpeg the internal URL, never the public one', async () => {
      // The worker never leaves the Compose network. Signing with the public
      // endpoint would still work here and fail only where it matters.
      const { processor, storage, ffmpeg } = build();

      await processor.process(makeJob());

      expect(storage.presignInternalGet).toHaveBeenCalledWith(
        storageCfg.videosBucket,
        expect.any(String),
        videoCfg.processingUrlTtlSeconds,
      );
      expect(storage.presignGet).not.toHaveBeenCalled();
      expect(ffmpeg.probe).toHaveBeenCalledWith('http://minio:9000/signed');
    });

    it('derives the thumbnail timestamp from the measured duration', async () => {
      // A fixed timestamp past the end of a short video produces an empty
      // frame with exit code 0.
      const { processor, ffmpeg } = build();

      await processor.process(makeJob());

      expect(ffmpeg.thumbnailTimestamp).toHaveBeenCalledWith(2);
      expect(ffmpeg.extractThumbnail).toHaveBeenCalledWith(
        'http://minio:9000/signed',
        0.5,
      );
    });

    it('stores the thumbnail in the thumbnails bucket as JPEG', async () => {
      const { processor, storage } = build();

      await processor.process(makeJob());

      const [bucket, , body, contentType] = storage.putObject.mock.calls[0] as [
        string,
        string,
        Buffer,
        string,
      ];
      expect(bucket).toBe(storageCfg.thumbnailsBucket);
      expect(contentType).toBe('image/jpeg');
      expect(body.length).toBeGreaterThan(0);
    });
  });

  describe('failure handling', () => {
    it('rethrows and leaves the video processing when attempts remain', async () => {
      // A transient storage timeout on attempt 1 is not a permanent outcome.
      const { processor, repository, ffmpeg } = build();
      ffmpeg.probe.mockRejectedValue(new Error('connection reset'));

      await expect(processor.process(makeJob(0, 3))).rejects.toThrow(
        'connection reset',
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('marks the video failed with the reason on the last attempt', async () => {
      const { processor, repository, ffmpeg } = build();
      ffmpeg.probe.mockRejectedValue(new Error('Invalid data found'));

      await expect(processor.process(makeJob(2, 3))).rejects.toThrow(
        'Invalid data found',
      );

      const saved = repository.save.mock.calls[0][0];
      expect(saved.status).toBe(VideoStatus.FAILED);
      expect(saved.processing_error).toBe('Invalid data found');
    });

    it('rethrows even on the last attempt, so the job stays inspectable', async () => {
      // Swallowing here would report success to BullMQ, and a job removed on
      // completion takes the evidence of the failure with it.
      const { processor, ffmpeg } = build();
      ffmpeg.probe.mockRejectedValue(new Error('boom'));

      await expect(processor.process(makeJob(2, 3))).rejects.toThrow('boom');
    });

    it('records a failure from the thumbnail step, not only from the probe', async () => {
      const { processor, repository, ffmpeg } = build();
      ffmpeg.extractThumbnail.mockRejectedValue(
        new Error('produced an empty frame'),
      );

      await expect(processor.process(makeJob(2, 3))).rejects.toThrow();

      const saved = repository.save.mock.calls[0][0];
      expect(saved.status).toBe(VideoStatus.FAILED);
      expect(saved.processing_error).toContain('empty frame');
    });

    it('treats a single-attempt job as its own last attempt', async () => {
      const { processor, repository, ffmpeg } = build();
      ffmpeg.probe.mockRejectedValue(new Error('nope'));

      await expect(processor.process(makeJob(0, 1))).rejects.toThrow();

      const saved = repository.save.mock.calls[0][0];
      expect(saved.status).toBe(VideoStatus.FAILED);
    });
  });

  describe('missing video', () => {
    it('drops the job without throwing when the row no longer exists', async () => {
      // Retrying cannot bring the row back, so this is one of the two contexts
      // where logging without rethrowing is the correct behaviour.
      const { processor, repository, ffmpeg } = build(null);

      await expect(processor.process(makeJob())).resolves.toBeUndefined();
      expect(ffmpeg.probe).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
    });
  });
});
