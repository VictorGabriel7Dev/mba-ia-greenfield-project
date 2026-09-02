import { Type } from 'class-transformer';
import { IsInt, IsPositive, IsString, Length } from 'class-validator';

export class CreateVideoDto {
  /** Title shown for the video. */
  @IsString()
  @Length(1, 255)
  title: string;

  /** Original file name, kept for the download filename. */
  @IsString()
  @Length(1, 255)
  filename: string;

  /**
   * Declared MIME type. Checked against the configured allowlist, but never
   * trusted: the bytes go straight to storage, so the API cannot verify it.
   * The authoritative check runs in the worker via ffprobe.
   */
  @IsString()
  @Length(1, 100)
  content_type: string;

  /** Size in bytes. Used to compute how many parts the upload needs. */
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  size_bytes: number;
}
