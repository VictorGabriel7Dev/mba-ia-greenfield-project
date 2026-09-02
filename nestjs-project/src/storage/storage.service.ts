import { Inject, Injectable } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { STORAGE_CLIENTS } from './storage.constants';
import type {
  CompletedPart,
  PresignGetOptions,
  PresignedPart,
} from './storage.types';

/**
 * The only place in the codebase that knows the S3 API exists.
 *
 * Every `ttlSeconds` argument is in **seconds**: the presigner's `expiresIn`
 * is documented in seconds, and a value passed in milliseconds produces a URL
 * that outlives its intended window by a factor of a thousand while looking
 * perfectly normal.
 */
@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_CLIENTS.INTERNAL)
    private readonly internalClient: S3Client,
    @Inject(STORAGE_CLIENTS.PUBLIC)
    private readonly publicClient: S3Client,
  ) {}

  async createMultipartUpload(
    bucket: string,
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!result.UploadId) {
      throw new Error(
        `Storage did not return an UploadId for ${bucket}/${key}`,
      );
    }

    return result.UploadId;
  }

  /**
   * Signed with the **public** client: these URLs are used by the browser to
   * send bytes straight to storage, which is the whole point of TD-02.
   */
  async presignUploadParts(
    bucket: string,
    key: string,
    uploadId: string,
    partCount: number,
    ttlSeconds: number,
  ): Promise<PresignedPart[]> {
    const parts: PresignedPart[] = [];

    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await getSignedUrl(
        this.publicClient,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: ttlSeconds },
      );
      parts.push({ partNumber, url });
    }

    return parts;
  }

  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    // S3 assembles the object by ascending part number and rejects a list that
    // is out of order. The client may report parts in completion order, which
    // for parallel uploads is not the same thing.
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: ordered.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /** Presigned read for a client outside the Docker network. */
  async presignGet(
    bucket: string,
    key: string,
    ttlSeconds: number,
    options: PresignGetOptions = {},
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(options.contentDisposition && {
          ResponseContentDisposition: options.contentDisposition,
        }),
      }),
      { expiresIn: ttlSeconds },
    );
  }

  /**
   * Presigned read for a server-side consumer, currently only the URL handed
   * to FFmpeg by the worker (TD-05). Signed with the internal endpoint because
   * the worker is on the Compose network and never leaves it.
   */
  async presignInternalGet(
    bucket: string,
    key: string,
    ttlSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  /** Small objects only. Video files never pass through the API (TD-02). */
  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async headObject(
    bucket: string,
    key: string,
  ): Promise<{ contentLength: number }> {
    const result = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );

    return { contentLength: result.ContentLength ?? 0 };
  }
}
