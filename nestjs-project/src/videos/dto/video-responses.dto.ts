import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

/**
 * Response DTOs carry no class-validator decorators, so the Swagger CLI plugin
 * has nothing to introspect: every field needs an explicit `@ApiProperty`.
 */

export class PresignedPartDto {
  @ApiProperty({ example: 1, description: 'One-based part number.' })
  part_number: number;

  @ApiProperty({
    description: 'Presigned URL to PUT this part directly to storage.',
    example: 'https://storage.example/streamtube-videos/...?X-Amz-Signature=...',
  })
  url: string;
}

export class UploadInstructionsDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ab3dEf6hIj9k', description: 'Public URL identifier.' })
  public_id: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ description: 'Storage multipart upload identifier.' })
  upload_id: string;

  @ApiProperty({
    example: 104857600,
    description:
      'Size every part except the last one must have. Storage rejects smaller parts at completion time.',
  })
  part_size_bytes: number;

  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];
}

export class UploadCompletedDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  public_id: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.PROCESSING })
  status: VideoStatus;

  @ApiProperty({
    example: 10737418240,
    description: 'Size measured by storage, not the size declared by the client.',
  })
  size_bytes: number;
}

export class VideoStatusDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ required: false, nullable: true, example: 12.345 })
  duration_seconds: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Reason of the failure. Non-null only when status is failed.',
  })
  processing_error: string | null;
}

export class VideoChannelDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'johndoe' })
  nickname: string;

  @ApiProperty({ example: 'johndoe' })
  name: string;
}

export class PublicVideoDto {
  @ApiProperty({ example: 'Ab3dEf6hIj9k' })
  public_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ required: false, nullable: true, example: 12.345 })
  duration_seconds: number | null;

  @ApiProperty({ type: VideoChannelDto })
  channel: VideoChannelDto;

  @ApiProperty({ format: 'date-time' })
  created_at: Date;
}
