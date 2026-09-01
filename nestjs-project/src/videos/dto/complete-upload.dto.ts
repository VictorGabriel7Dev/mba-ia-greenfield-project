import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  /** 1-based part number, as returned by the initiation call. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  part_number: number;

  /** ETag returned by storage in the response to the part upload. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @IsArray()
  @ArrayMinSize(1)
  // The S3 ceiling. A larger list is rejected by storage anyway; rejecting it
  // here keeps the failure at the edge, with a field-level message.
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
