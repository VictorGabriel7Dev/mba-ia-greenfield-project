import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  PublicVideoDto,
  UploadCompletedDto,
  UploadInstructionsDto,
  VideoStatusDto,
} from './dto/video-responses.dto';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

const ERROR_SCHEMA = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(201)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft and opens a multipart upload. Returns one presigned URL per part; the client uploads the parts straight to storage, so no byte of the file passes through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and upload opened',
    type: UploadInstructionsDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Unsupported content type, file too large, or invalid body',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'The authenticated user has no channel',
    schema: ERROR_SCHEMA,
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<UploadInstructionsDto> {
    const result = await this.videosService.initiateUpload(user.sub, {
      title: dto.title,
      filename: dto.filename,
      contentType: dto.content_type,
      sizeBytes: dto.size_bytes,
    });

    return {
      id: result.video.id,
      public_id: result.video.public_id,
      status: result.video.status,
      upload_id: result.video.upload_id ?? '',
      part_size_bytes: result.partSizeBytes,
      parts: result.parts.map((part) => ({
        part_number: part.partNumber,
        url: part.url,
      })),
    };
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Finish a video upload',
    description:
      'Assembles the uploaded parts in storage, records the size measured by storage, moves the video to processing and enqueues it for the worker.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload assembled and queued for processing',
    type: UploadCompletedDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid body',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 403,
    description: 'The video belongs to another channel',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'The video is not a draft, or has no open upload',
    schema: ERROR_SCHEMA,
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<UploadCompletedDto> {
    const video = await this.videosService.completeUpload(
      user.sub,
      id,
      dto.parts.map((part) => ({
        partNumber: part.part_number,
        etag: part.etag,
      })),
    );

    return {
      id: video.id,
      public_id: video.public_id,
      status: video.status,
      size_bytes: video.size_bytes ?? 0,
    };
  }

  @Post(':id/abort')
  @HttpCode(204)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Cancels the multipart upload so storage releases the parts it is holding. An initiated upload never expires on its own. The draft row is kept.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 403,
    description: 'The video belongs to another channel',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'There is no open upload to abort',
    schema: ERROR_SCHEMA,
  })
  async abort(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, id);
  }

  @Get(':id/status')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Read the processing status of an owned video',
    description:
      'Addressed by internal id and restricted to the owner. Processing is asynchronous, so this is the surface the owner polls while the video is not ready yet.',
  })
  @ApiResponse({
    status: 200,
    description: 'Current status',
    type: VideoStatusDto,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 403,
    description: 'The video belongs to another channel',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: ERROR_SCHEMA,
  })
  async status(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoStatusDto> {
    const video = await this.videosService.findStatusForOwner(user.sub, id);

    return {
      id: video.id,
      status: video.status,
      duration_seconds: video.duration_seconds,
      processing_error: video.processing_error,
    };
  }

  @Public()
  @Get(':publicId')
  @ApiOperation({
    summary: 'Read a published video',
    description:
      'Anonymous. A video that is not ready is reported as not found, so a draft cannot be discovered by probing public identifiers.',
  })
  @ApiResponse({ status: 200, description: 'The video', type: PublicVideoDto })
  @ApiResponse({
    status: 404,
    description: 'Unknown identifier, or the video is not ready',
    schema: ERROR_SCHEMA,
  })
  async findOne(@Param('publicId') publicId: string): Promise<PublicVideoDto> {
    const video = await this.videosService.findPublicByPublicId(publicId);
    return toPublicVideo(video);
  }

  @Public()
  @Get(':publicId/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a short-lived presigned URL on the object storage. Storage answers range requests with 206 Partial Content, so playback starts without downloading the whole file.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the storage URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: ERROR_SCHEMA,
  })
  async stream(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    return {
      url: await this.videosService.buildStreamUrl(publicId),
      statusCode: 302,
    };
  }

  @Public()
  @Get(':publicId/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Same mechanism as streaming, with a content disposition that makes the browser save the file under its original name.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the storage URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: ERROR_SCHEMA,
  })
  async download(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    return {
      url: await this.videosService.buildDownloadUrl(publicId),
      statusCode: 302,
    };
  }

  @Public()
  @Get(':publicId/thumbnail')
  @Redirect()
  @ApiOperation({
    summary: 'Get the video thumbnail',
    description:
      'Redirects to the presigned URL of the frame extracted during processing.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the storage URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or it has no thumbnail',
    schema: ERROR_SCHEMA,
  })
  async thumbnail(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    return {
      url: await this.videosService.buildThumbnailUrl(publicId),
      statusCode: 302,
    };
  }
}

function toPublicVideo(video: Video): PublicVideoDto {
  return {
    public_id: video.public_id,
    title: video.title,
    duration_seconds: video.duration_seconds,
    channel: {
      id: video.channel.id,
      nickname: video.channel.nickname,
      name: video.channel.name,
    },
    created_at: video.created_at,
  };
}
