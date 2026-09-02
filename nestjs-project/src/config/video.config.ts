import { registerAs } from '@nestjs/config';

const DEFAULT_MAX_SIZE_BYTES = '10737418240'; // 10 GiB, the ceiling in the project plan
const DEFAULT_PART_SIZE_BYTES = '104857600'; // 100 MiB: ~103 parts for 10 GiB, far below the 10000-part S3 limit
const DEFAULT_ALLOWED_CONTENT_TYPES =
  'video/mp4,video/quicktime,video/x-matroska,video/webm,video/x-msvideo';

export default registerAs('video', () => ({
  maxSizeBytes: parseInt(
    process.env.VIDEO_MAX_SIZE_BYTES || DEFAULT_MAX_SIZE_BYTES,
    10,
  ),
  partSizeBytes: parseInt(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES || DEFAULT_PART_SIZE_BYTES,
    10,
  ),
  // Seconds. The presigner's `expiresIn` is in seconds, not milliseconds.
  uploadUrlTtlSeconds: parseInt(
    process.env.VIDEO_UPLOAD_URL_TTL_SECONDS || '3600',
    10,
  ),
  playbackUrlTtlSeconds: parseInt(
    process.env.VIDEO_PLAYBACK_URL_TTL_SECONDS || '900',
    10,
  ),
  processingUrlTtlSeconds: parseInt(
    process.env.VIDEO_PROCESSING_URL_TTL_SECONDS || '7200',
    10,
  ),
  allowedContentTypes: (
    process.env.VIDEO_ALLOWED_CONTENT_TYPES || DEFAULT_ALLOWED_CONTENT_TYPES
  )
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0),
}));
