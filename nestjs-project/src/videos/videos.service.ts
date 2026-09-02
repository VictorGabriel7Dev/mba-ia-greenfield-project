import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  FileTooLargeException,
  InvalidVideoStateException,
  ThumbnailNotAvailableException,
  UnsupportedContentTypeException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import type { CompletedPart, PresignedPart } from '../storage/storage.types';
import { Video } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { VideoStatus } from './video-status.enum';
import {
  SOURCE_BASENAME,
  VIDEO_JOB_OPTIONS,
  VIDEO_PROCESS_JOB,
  VIDEO_QUEUE,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_MAX_ATTEMPTS = 5;

function isPublicIdCollision(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as unknown as { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes('public_id')
  );
}

export interface UploadInstructions {
  video: Video;
  partSizeBytes: number;
  parts: PresignedPart[];
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_QUEUE)
    private readonly queue: Queue,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
    @Inject(videoConfig.KEY)
    private readonly video: ConfigType<typeof videoConfig>,
  ) {}

  /**
   * Pre-registers the video as a draft and opens a multipart upload.
   *
   * No byte of the file reaches this process: the client uploads each part
   * straight to storage with the presigned URLs returned here.
   */
  async initiateUpload(
    userId: string,
    input: {
      title: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
    },
  ): Promise<UploadInstructions> {
    const contentType = input.contentType.toLowerCase();
    if (!this.video.allowedContentTypes.includes(contentType)) {
      throw new UnsupportedContentTypeException(input.contentType);
    }
    if (input.sizeBytes > this.video.maxSizeBytes) {
      throw new FileTooLargeException(this.video.maxSizeBytes);
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    // The id is generated here rather than by the database because the storage
    // key is derived from it and has to exist before the row is written.
    const videoId = randomUUID();
    const storageKey = this.buildSourceKey(channel.id, videoId, input.filename);
    const partCount = Math.ceil(input.sizeBytes / this.video.partSizeBytes);

    const uploadId = await this.storageService.createMultipartUpload(
      this.storage.videosBucket,
      storageKey,
      contentType,
    );

    let video: Video;
    try {
      video = await this.saveWithUniquePublicId({
        id: videoId,
        channel_id: channel.id,
        title: input.title,
        status: VideoStatus.DRAFT,
        storage_key: storageKey,
        original_filename: input.filename,
        content_type: contentType,
        size_bytes: input.sizeBytes,
        upload_id: uploadId,
      });
    } catch (err) {
      // Compensate: an initiated upload never expires on its own, so a row we
      // failed to write would leave parts accumulating with nothing pointing
      // at them. Same shape as the compensation in UsersService.
      await this.storageService.abortMultipartUpload(
        this.storage.videosBucket,
        storageKey,
        uploadId,
      );
      throw err;
    }

    const parts = await this.storageService.presignUploadParts(
      this.storage.videosBucket,
      storageKey,
      uploadId,
      partCount,
      this.video.uploadUrlTtlSeconds,
    );

    return { video, partSizeBytes: this.video.partSizeBytes, parts };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    parts: CompletedPart[],
  ): Promise<Video> {
    const video = await this.loadOwnedVideo(userId, videoId);

    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidVideoStateException(
        `expected draft, found ${video.status}`,
      );
    }
    if (!video.upload_id) {
      throw new InvalidVideoStateException('no open upload to complete');
    }

    await this.storageService.completeMultipartUpload(
      this.storage.videosBucket,
      video.storage_key,
      video.upload_id,
      parts,
    );

    // The size declared at initiation was a claim by the client. This is the
    // measurement, and it is what gets persisted.
    const { contentLength } = await this.storageService.headObject(
      this.storage.videosBucket,
      video.storage_key,
    );

    video.size_bytes = contentLength;
    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    const saved = await this.videoRepository.save(video);

    await this.queue.add(
      VIDEO_PROCESS_JOB,
      { videoId: saved.id },
      { jobId: saved.id, ...VIDEO_JOB_OPTIONS },
    );

    return saved;
  }

  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.loadOwnedVideo(userId, videoId);

    if (!video.upload_id) {
      throw new InvalidVideoStateException('no open upload to abort');
    }

    await this.storageService.abortMultipartUpload(
      this.storage.videosBucket,
      video.storage_key,
      video.upload_id,
    );

    // The row is not deleted. It stays a draft with no open upload; deciding
    // its fate is video management, which belongs to a later phase.
    video.upload_id = null;
    await this.videoRepository.save(video);
  }

  async findStatusForOwner(userId: string, videoId: string): Promise<Video> {
    return this.loadOwnedVideo(userId, videoId);
  }

  /**
   * Public read. A video that is not `ready` is reported as not found, so its
   * existence cannot be probed through the public identifier.
   */
  async findPublicByPublicId(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, status: VideoStatus.READY },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async buildStreamUrl(publicId: string): Promise<string> {
    const video = await this.findPublicByPublicId(publicId);
    return this.storageService.presignGet(
      this.storage.videosBucket,
      video.storage_key,
      this.video.playbackUrlTtlSeconds,
    );
  }

  async buildDownloadUrl(publicId: string): Promise<string> {
    const video = await this.findPublicByPublicId(publicId);
    return this.storageService.presignGet(
      this.storage.videosBucket,
      video.storage_key,
      this.video.playbackUrlTtlSeconds,
      {
        contentDisposition: `attachment; filename="${sanitizeFilename(
          video.original_filename,
        )}"`,
      },
    );
  }

  async buildThumbnailUrl(publicId: string): Promise<string> {
    const video = await this.findPublicByPublicId(publicId);
    if (!video.thumbnail_key) {
      throw new ThumbnailNotAvailableException();
    }
    return this.storageService.presignGet(
      this.storage.thumbnailsBucket,
      video.thumbnail_key,
      this.video.playbackUrlTtlSeconds,
    );
  }

  private async loadOwnedVideo(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }
    if (video.channel_id !== channel.id) {
      throw new VideoNotOwnedException();
    }

    return video;
  }

  private buildSourceKey(
    channelId: string,
    videoId: string,
    filename: string,
  ): string {
    // Derived from immutable ids only. Title and public_id are both mutable or
    // routing concerns; binding either into the key would mean rewriting
    // objects when they change.
    const ext = extname(filename).toLowerCase().slice(0, 10);
    return `channels/${channelId}/videos/${videoId}/${SOURCE_BASENAME}${ext}`;
  }

  /**
   * Inserts, regenerating `public_id` if the unique constraint rejects it.
   *
   * At 72 bits of entropy this loop realistically never runs twice, but the
   * database constraint is what makes the uniqueness promise, so the code that
   * honours it has to exist and be tested.
   */
  private async saveWithUniquePublicId(
    data: Omit<Partial<Video>, 'public_id'>,
  ): Promise<Video> {
    let lastError: unknown;

    for (let attempt = 0; attempt < PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...data,
            public_id: generatePublicId(),
          }),
        );
      } catch (err) {
        if (!isPublicIdCollision(err)) {
          throw err;
        }
        lastError = err;
      }
    }

    throw lastError;
  }
}

/**
 * Keeps the filename usable inside a `Content-Disposition` header.
 *
 * A quote or a newline in the original name would terminate the header value
 * early, which is a response-splitting vector rather than a cosmetic problem.
 */
function sanitizeFilename(filename: string): string {
  return filename.replace(/[\r\n"\\]/g, '_').slice(0, 200);
}
