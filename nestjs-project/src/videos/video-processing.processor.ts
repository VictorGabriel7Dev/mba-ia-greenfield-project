import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoStatus } from './video-status.enum';
import {
  THUMBNAIL_CONTENT_TYPE,
  THUMBNAIL_FILENAME,
  VIDEO_QUEUE,
} from './videos.constants';

export interface ProcessVideoJobData {
  videoId: string;
}

@Processor(VIDEO_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
    @Inject(videoConfig.KEY)
    private readonly video: ConfigType<typeof videoConfig>,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;

    // The payload carries only the id, so this read is the current state of
    // the row rather than a snapshot taken when the job was enqueued.
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    if (!video) {
      // Nothing to do and nothing a retry could fix. This is one of the two
      // contexts where logging without rethrowing is the correct behaviour.
      this.logger.warn(`Video ${videoId} no longer exists; dropping the job`);
      return;
    }

    try {
      // Internal endpoint: this URL is consumed by FFmpeg inside the Compose
      // network, never by a browser.
      const sourceUrl = await this.storageService.presignInternalGet(
        this.storage.videosBucket,
        video.storage_key,
        this.video.processingUrlTtlSeconds,
      );

      const { durationSeconds, metadata } =
        await this.ffmpegService.probe(sourceUrl);

      const frame = await this.ffmpegService.extractThumbnail(
        sourceUrl,
        this.ffmpegService.thumbnailTimestamp(durationSeconds),
      );

      const thumbnailKey = `channels/${video.channel_id}/videos/${video.id}/${THUMBNAIL_FILENAME}`;
      await this.storageService.putObject(
        this.storage.thumbnailsBucket,
        thumbnailKey,
        frame,
        THUMBNAIL_CONTENT_TYPE,
      );

      video.duration_seconds = durationSeconds;
      video.metadata = metadata;
      video.thumbnail_key = thumbnailKey;
      video.status = VideoStatus.READY;
      video.processing_error = null;
      await this.videoRepository.save(video);

      this.logger.log(`Video ${videoId} is ready (${durationSeconds}s)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (this.isLastAttempt(job)) {
        // Only an exhausted job is a permanent outcome. A transient storage
        // timeout on attempt 1 must not mark the video failed.
        video.status = VideoStatus.FAILED;
        video.processing_error = message;
        await this.videoRepository.save(video);
        this.logger.error(`Video ${videoId} failed permanently: ${message}`);
      } else {
        this.logger.warn(
          `Video ${videoId} attempt ${job.attemptsMade + 1} failed, will retry: ${message}`,
        );
      }

      // Rethrowing is what tells BullMQ the attempt failed. Swallowing here
      // would report success, remove the job and never retry it.
      throw err;
    }
  }

  private isLastAttempt(job: Job<ProcessVideoJobData>): boolean {
    const configured = job.opts.attempts ?? 1;
    return job.attemptsMade + 1 >= configured;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ProcessVideoJobData> | undefined, err: Error): void {
    this.logger.warn(
      `Job ${job?.id ?? '(unknown)'} failed on attempt ${
        (job?.attemptsMade ?? 0) + 1
      }: ${err.message}`,
    );
  }
}
