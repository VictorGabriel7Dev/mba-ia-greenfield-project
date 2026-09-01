import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { FfmpegService } from './ffmpeg.service';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

const mockedSpawn = spawn as unknown as jest.Mock;

/**
 * Minimal stand-in for a ChildProcess: two streams plus the close event.
 *
 * The real binaries live only in the worker image (TD-04), and the container
 * that runs this suite does not have them. Their real behaviour is covered end
 * to end against the actual worker container, which is a stronger check than a
 * mocked binary. A test that skipped itself when ffmpeg is missing would be
 * worse than either: it would report green while asserting nothing.
 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn();
}

function scheduleRun(
  child: FakeChild,
  opts: { stdout?: Buffer; stderr?: string; code?: number },
): void {
  setImmediate(() => {
    if (opts.stdout) child.stdout.emit('data', opts.stdout);
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('close', opts.code ?? 0);
  });
}

const PROBE_JSON = JSON.stringify({
  format: {
    duration: '12.345',
    bit_rate: '4500000',
    format_name: 'mov,mp4,m4a',
  },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
});

describe('FfmpegService', () => {
  let service: FfmpegService;
  let child: FakeChild;

  beforeEach(() => {
    service = new FfmpegService();
    child = new FakeChild();
    mockedSpawn.mockReset();
    mockedSpawn.mockReturnValue(child);
  });

  function spawnArgs(): { command: string; args: string[] } {
    const call = mockedSpawn.mock.calls[0] as [string, string[]];
    return { command: call[0], args: call[1] };
  }

  describe('probe', () => {
    it('builds the documented ffprobe command line', async () => {
      scheduleRun(child, { stdout: Buffer.from(PROBE_JSON) });

      await service.probe('https://storage/video.mp4');

      const { command, args } = spawnArgs();
      expect(command).toBe('ffprobe');
      expect(args).toEqual([
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        'https://storage/video.mp4',
      ]);
    });

    it('passes arguments as an array, never as a shell string', async () => {
      // A filename reaching a shell would be interpreted as syntax.
      scheduleRun(child, { stdout: Buffer.from(PROBE_JSON) });

      await service.probe('https://storage/a b; rm -rf /.mp4');

      const call = mockedSpawn.mock.calls[0] as unknown[];
      expect(Array.isArray(call[1])).toBe(true);
      expect(call[2]).toBeUndefined();
    });

    it('extracts duration and metadata from the probe output', async () => {
      scheduleRun(child, { stdout: Buffer.from(PROBE_JSON) });

      const result = await service.probe('https://storage/video.mp4');

      expect(result.durationSeconds).toBeCloseTo(12.345, 3);
      expect(result.metadata).toEqual({
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: 'aac',
        bitRate: 4500000,
        formatName: 'mov,mp4,m4a',
      });
    });

    it('rejects when the command exits non-zero, reporting stderr', async () => {
      scheduleRun(child, { stderr: 'Invalid data found', code: 1 });

      await expect(service.probe('https://storage/x')).rejects.toThrow(
        /Invalid data found/,
      );
    });

    it('rejects on exit 0 with empty stdout instead of returning empty metadata', async () => {
      // The silent-failure case: treating it as success would store a video
      // with no duration and mark it ready.
      scheduleRun(child, { code: 0 });

      await expect(service.probe('https://storage/x')).rejects.toThrow(
        /produced no output/,
      );
    });

    it('rejects when stdout is not valid JSON', async () => {
      scheduleRun(child, { stdout: Buffer.from('not json') });

      await expect(service.probe('https://storage/x')).rejects.toThrow(
        /not valid JSON/,
      );
    });

    it('rejects a probe with no usable duration', async () => {
      scheduleRun(child, {
        stdout: Buffer.from(JSON.stringify({ format: {}, streams: [] })),
      });

      await expect(service.probe('https://storage/x')).rejects.toThrow(
        /no usable duration/,
      );
    });

    it('rejects a duration of zero', async () => {
      scheduleRun(child, {
        stdout: Buffer.from(JSON.stringify({ format: { duration: '0' } })),
      });

      await expect(service.probe('https://storage/x')).rejects.toThrow(
        /no usable duration/,
      );
    });

    it('rejects when the binary cannot be spawned', async () => {
      setImmediate(() => child.emit('error', new Error('ENOENT')));

      await expect(service.probe('https://storage/x')).rejects.toThrow(
        /ENOENT/,
      );
    });
  });

  describe('extractThumbnail', () => {
    it('places -ss before -i so the seek happens before decoding', async () => {
      // After -i, FFmpeg decodes everything up to the timestamp, which against
      // a remote multi-gigabyte input means reading the whole file.
      scheduleRun(child, { stdout: Buffer.from([0xff, 0xd8, 0xff]) });

      await service.extractThumbnail('https://storage/video.mp4', 3.5);

      const { command, args } = spawnArgs();
      expect(command).toBe('ffmpeg');
      expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
      expect(args[args.indexOf('-ss') + 1]).toBe('3.500');
      expect(args[args.length - 1]).toBe('-');
    });

    it('asks for exactly one frame', async () => {
      scheduleRun(child, { stdout: Buffer.from([0xff, 0xd8, 0xff]) });

      await service.extractThumbnail('https://storage/video.mp4', 1);

      const { args } = spawnArgs();
      expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
    });

    it('returns the frame bytes', async () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      scheduleRun(child, { stdout: jpeg });

      const result = await service.extractThumbnail('https://storage/x', 1);

      expect(result.equals(jpeg)).toBe(true);
    });

    it('rejects an empty frame instead of storing zero bytes', async () => {
      // Seeking past the end of a video exits 0 and writes nothing. Without
      // this check the video is marked ready with a zero-byte thumbnail and
      // every status says everything worked.
      scheduleRun(child, { code: 0 });

      await expect(
        service.extractThumbnail('https://storage/x', 999),
      ).rejects.toThrow(/no output|empty frame/);
    });
  });

  describe('thumbnailTimestamp', () => {
    it.each([12.345, 1, 0.5, 0.2, 3600])(
      'stays strictly inside a video of %s seconds',
      (duration) => {
        const timestamp = service.thumbnailTimestamp(duration);

        expect(timestamp).toBeGreaterThanOrEqual(0);
        expect(timestamp).toBeLessThan(duration);
      },
    );

    it('returns a usable position for a video shorter than one second', () => {
      expect(service.thumbnailTimestamp(0.5)).toBeGreaterThan(0);
    });

    it('returns zero for a duration that is missing or nonsensical', () => {
      expect(service.thumbnailTimestamp(0)).toBe(0);
      expect(service.thumbnailTimestamp(-5)).toBe(0);
      expect(service.thumbnailTimestamp(Number.NaN)).toBe(0);
      expect(service.thumbnailTimestamp(Number.POSITIVE_INFINITY)).toBe(0);
    });
  });
});
