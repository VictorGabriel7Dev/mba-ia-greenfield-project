import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VideoStatus } from '../video-status.enum';

/**
 * TypeORM returns `bigint` and `numeric` columns as **strings**, because they
 * can exceed the JavaScript safe integer range. Without a transformer,
 * `size_bytes` silently becomes a string and every comparison against it is a
 * string comparison that still "works" for some values and quietly does not
 * for others ("9" > "10" is true).
 *
 * 10 GiB is 10737418240, well inside Number.MAX_SAFE_INTEGER, so converting is
 * safe at the sizes this column is constrained to.
 */
const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null || value === undefined ? null : Number(value),
};

export interface VideoMetadata {
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  bitRate?: number;
  formatName?: string;
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Short public identifier used in the video URL. See TD-07. */
  @Column({ type: 'varchar', length: 16, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Index()
  @Column({
    type: 'enum',
    enum: VideoStatus,
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  /** `channels/<channel_id>/videos/<video_id>/source<ext>`. See TD-03. */
  @Column({ type: 'varchar', length: 512 })
  storage_key: string;

  /** Null until the worker has produced a thumbnail. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  /** Declared by the client at initiation, therefore not authoritative (TD-12). */
  @Column({ type: 'varchar', length: 100 })
  content_type: string;

  /** Declared at initiation, overwritten with the value measured by storage. */
  @Column({ type: 'bigint', nullable: true, transformer: numericTransformer })
  size_bytes: number | null;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 3,
    nullable: true,
    transformer: numericTransformer,
  })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  /** S3 multipart upload id. Cleared once the upload completes or is aborted. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  /** Written only when the status becomes `failed`. */
  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
