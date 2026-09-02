import * as Joi from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY: 'storage-key',
  STORAGE_SECRET_KEY: 'storage-secret',
};

/** The subset of the validated environment these tests make assertions about. */
interface ValidatedEnv {
  SWAGGER_ENABLED: string;
  STORAGE_ENDPOINT: string;
  STORAGE_PUBLIC_ENDPOINT: string;
  QUEUE_HOST: string;
  QUEUE_PORT: number;
  VIDEO_MAX_SIZE_BYTES: number;
  VIDEO_UPLOAD_PART_SIZE_BYTES: number;
}

const validate = (
  env: Record<string, string>,
): Joi.ValidationResult<ValidatedEnv> =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as Joi.ValidationResult<ValidatedEnv>;

/**
 * `Joi.ValidationResult` is a union: on the error branch `value` is `any`.
 * Destructuring both fields at once therefore yields an untyped value. This
 * helper narrows to the success branch, and fails with the real reason when
 * validation unexpectedly rejects the input.
 */
function validValue(env: Record<string, string>): ValidatedEnv {
  const result = validate(env);
  if (result.error) {
    throw new Error(`expected a valid environment: ${result.error.message}`);
  }
  return result.value;
}

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    expect(validValue({}).SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage credentials', () => {
  const withoutKey = (key: string) => {
    const env = { ...requiredEnv } as Record<string, string>;
    delete env[key];
    return envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });
  };

  it('should reject a missing STORAGE_ACCESS_KEY', () => {
    const { error } = withoutKey('STORAGE_ACCESS_KEY');
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ACCESS_KEY');
  });

  it('should reject a missing STORAGE_SECRET_KEY', () => {
    const { error } = withoutKey('STORAGE_SECRET_KEY');
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_SECRET_KEY');
  });

  it('should default the endpoints to the Compose service name and a distinct public host', () => {
    const value = validValue({});

    expect(value.STORAGE_ENDPOINT).toBe('http://minio:9000');
    // The two must not collapse into the same default: a browser cannot
    // resolve the Compose service name.
    expect(value.STORAGE_PUBLIC_ENDPOINT).not.toBe(value.STORAGE_ENDPOINT);
  });

  it('should reject a STORAGE_ENDPOINT without an http or https scheme', () => {
    // `Joi.string().uri()` on its own accepts "minio:9000", reading it as
    // scheme "minio" with path "9000". The value then fails inside the S3
    // client, far from its cause.
    const { error } = validate({ STORAGE_ENDPOINT: 'minio:9000' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ENDPOINT');
  });
});

describe('envValidationSchema — video upload limits', () => {
  it('should coerce numeric env vars from strings', () => {
    const value = validValue({
      VIDEO_MAX_SIZE_BYTES: '10737418240',
      QUEUE_PORT: '6379',
    });

    expect(value.VIDEO_MAX_SIZE_BYTES).toBe(10737418240);
    expect(value.QUEUE_PORT).toBe(6379);
  });

  it('should apply the documented defaults', () => {
    const value = validValue({});

    expect(value.VIDEO_MAX_SIZE_BYTES).toBe(10737418240); // 10 GiB
    expect(value.VIDEO_UPLOAD_PART_SIZE_BYTES).toBe(104857600); // 100 MiB
    expect(value.QUEUE_HOST).toBe('redis');
  });

  it('should reject a part size below the 5 MiB S3 minimum', () => {
    // A smaller part size is accepted by every UploadPart call and only fails
    // at CompleteMultipartUpload, after the whole file has been transferred.
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '1048576' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });

  it('should reject a part size above the 5 GiB S3 maximum', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '6442450944' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });
});
