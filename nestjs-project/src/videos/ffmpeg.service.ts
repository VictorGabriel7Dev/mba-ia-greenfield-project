import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import type { VideoMetadata } from './entities/video.entity';

/** Position of the extracted frame, as a fraction of the duration. */
const THUMBNAIL_FRACTION = 0.25;

/** Never seek to the very end: a frame at or past it comes back empty. */
const THUMBNAIL_END_MARGIN_SECONDS = 0.05;

/**
 * Wall-clock ceiling for a single FFmpeg invocation. A remote read that stalls
 * would otherwise hold a worker slot indefinitely.
 */
const COMMAND_TIMEOUT_MS = 120_000;

export interface ProbeResult {
  durationSeconds: number;
  metadata: VideoMetadata;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeFormat {
  duration?: string;
  bit_rate?: string;
  format_name?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

export class FfmpegCommandError extends Error {
  constructor(command: string, detail: string) {
    super(`${command} failed: ${detail}`);
    this.name = 'FfmpegCommandError';
  }
}

@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  /**
   * Reads duration and metadata.
   *
   * `-print_format json` puts a parseable document on stdout, which is why no
   * wrapper library is needed. The input may be an http(s) URL: FFmpeg seeks
   * with range requests, so only the bytes it needs are transferred.
   */
  async probe(inputUrl: string): Promise<ProbeResult> {
    const stdout = await this.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputUrl,
    ]);

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout.toString('utf-8')) as FfprobeOutput;
    } catch {
      throw new FfmpegCommandError('ffprobe', 'output was not valid JSON');
    }

    const duration = Number(parsed.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      // A file FFmpeg cannot measure is not a playable video, whatever its
      // extension or its declared content type claimed.
      throw new FfmpegCommandError(
        'ffprobe',
        'no usable duration in the probe output',
      );
    }

    const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
    const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');
    const bitRate = Number(parsed.format?.bit_rate);

    return {
      durationSeconds: duration,
      metadata: {
        width: videoStream?.width,
        height: videoStream?.height,
        videoCodec: videoStream?.codec_name,
        audioCodec: audioStream?.codec_name,
        bitRate: Number.isFinite(bitRate) ? bitRate : undefined,
        formatName: parsed.format?.format_name,
      },
    };
  }

  /**
   * Extracts a single frame as JPEG, written to stdout so no temporary file is
   * created.
   *
   * `-ss` comes **before** `-i` on purpose: that seeks by keyframe before
   * decoding. After `-i` it would decode everything up to the timestamp, which
   * against a remote multi-gigabyte input is the difference between a couple
   * of range requests and reading the whole file.
   */
  async extractThumbnail(inputUrl: string, atSeconds: number): Promise<Buffer> {
    const frame = await this.run('ffmpeg', [
      '-v',
      'error',
      '-ss',
      atSeconds.toFixed(3),
      '-i',
      inputUrl,
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-vcodec',
      'mjpeg',
      '-',
    ]);

    if (frame.length === 0) {
      throw new FfmpegCommandError('ffmpeg', 'produced an empty frame');
    }
    return frame;
  }

  /**
   * Where to cut the thumbnail.
   *
   * Seeking past the end of a video is **not** an error for FFmpeg: it exits 0
   * and writes nothing. A fixed timestamp would therefore store a zero-byte
   * thumbnail for every video shorter than it, and mark them all ready.
   */
  thumbnailTimestamp(durationSeconds: number): number {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return 0;
    }
    const latestSafe = Math.max(
      0,
      durationSeconds - THUMBNAIL_END_MARGIN_SECONDS,
    );
    return Math.min(durationSeconds * THUMBNAIL_FRACTION, latestSafe);
  }

  /**
   * Runs a binary and resolves its stdout.
   *
   * Arguments are passed as an array, never as a shell string, so a filename
   * can never be interpreted as shell syntax.
   */
  private run(command: string, args: string[]): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(command, args);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        child.kill('SIGKILL');
        reject(
          new FfmpegCommandError(
            command,
            `timed out after ${COMMAND_TIMEOUT_MS}ms`,
          ),
        );
      }, COMMAND_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new FfmpegCommandError(command, err.message));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const errorText = Buffer.concat(stderr).toString('utf-8').trim();
        if (code !== 0) {
          reject(
            new FfmpegCommandError(
              command,
              `exited with code ${code ?? 'null'}: ${errorText || '(no stderr)'}`,
            ),
          );
          return;
        }

        const output = Buffer.concat(stdout);
        if (output.length === 0) {
          // Exit code 0 with no output is the silent-failure case: seeking
          // past the end, or an input FFmpeg decided it had nothing to say
          // about. Treating it as success stores an empty result.
          reject(
            new FfmpegCommandError(
              command,
              `exited 0 but produced no output${errorText ? `: ${errorText}` : ''}`,
            ),
          );
          return;
        }

        if (errorText) {
          this.logger.warn(`${command} succeeded with stderr: ${errorText}`);
        }
        resolve(output);
      });
    });
  }
}
