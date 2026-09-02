import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),

  // Object storage (S3-compatible; MinIO locally)
  // The scheme allowlist is not decoration: `Joi.string().uri()` alone accepts
  // "minio:9000", reading it as scheme "minio" with path "9000". That value
  // passes validation and then fails inside the S3 client, far from the cause.
  STORAGE_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://minio:9000'),
  STORAGE_PUBLIC_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:9000'),
  STORAGE_REGION: Joi.string().default('us-east-1'),
  // Required, like JWT_SECRET: a missing credential must stop the boot rather
  // than surface as a storage error on the first upload.
  STORAGE_ACCESS_KEY: Joi.string().required(),
  STORAGE_SECRET_KEY: Joi.string().required(),
  STORAGE_VIDEOS_BUCKET: Joi.string().default('streamtube-videos'),
  STORAGE_THUMBNAILS_BUCKET: Joi.string().default('streamtube-thumbnails'),

  // Processing queue (BullMQ over Redis)
  QUEUE_HOST: Joi.string().default('redis'),
  QUEUE_PORT: Joi.number().port().default(6379),

  // Video upload and playback
  VIDEO_MAX_SIZE_BYTES: Joi.number().positive().default(10737418240),
  // S3 rejects parts under 5 MiB (except the last one), so a smaller value
  // produces uploads that fail only at completion time.
  VIDEO_UPLOAD_PART_SIZE_BYTES: Joi.number()
    .min(5242880)
    .max(5368709120)
    .default(104857600),
  VIDEO_UPLOAD_URL_TTL_SECONDS: Joi.number().positive().default(3600),
  VIDEO_PLAYBACK_URL_TTL_SECONDS: Joi.number().positive().default(900),
  VIDEO_PROCESSING_URL_TTL_SECONDS: Joi.number().positive().default(7200),
  VIDEO_ALLOWED_CONTENT_TYPES: Joi.string().default(
    'video/mp4,video/quicktime,video/x-matroska,video/webm,video/x-msvideo',
  ),
});
