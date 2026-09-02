import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { STORAGE_CLIENTS } from './storage.constants';
import { StorageService } from './storage.service';

function buildClient(
  endpoint: string,
  cfg: ConfigType<typeof storageConfig>,
): S3Client {
  return new S3Client({
    region: cfg.region,
    endpoint,
    // Mandatory for MinIO. Without it the SDK addresses the bucket as a
    // subdomain (bucket.minio:9000), which does not resolve on this network.
    forcePathStyle: true,
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
  });
}

@Module({
  providers: [
    {
      provide: STORAGE_CLIENTS.INTERNAL,
      inject: [storageConfig.KEY],
      useFactory: (cfg: ConfigType<typeof storageConfig>) =>
        buildClient(cfg.endpoint, cfg),
    },
    {
      provide: STORAGE_CLIENTS.PUBLIC,
      inject: [storageConfig.KEY],
      useFactory: (cfg: ConfigType<typeof storageConfig>) =>
        buildClient(cfg.publicEndpoint, cfg),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
