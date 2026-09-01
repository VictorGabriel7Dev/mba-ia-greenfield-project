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

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

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
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
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

  it('should default the endpoints to the Compose service name and a public host', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.STORAGE_ENDPOINT).toBe('http://minio:9000');
    // The two must not collapse into the same value by default: a browser
    // cannot resolve the Compose service name.
    expect(value.STORAGE_PUBLIC_ENDPOINT).not.toBe(value.STORAGE_ENDPOINT);
  });

  it('should reject a non-URI STORAGE_ENDPOINT', () => {
    const { error } = validate({ STORAGE_ENDPOINT: 'minio:9000' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ENDPOINT');
  });
});

describe('envValidationSchema — video upload limits', () => {
  it('should coerce numeric env vars from strings', () => {
    const { value, error } = validate({
      VIDEO_MAX_SIZE_BYTES: '10737418240',
      QUEUE_PORT: '6379',
    });
    expect(error).toBeUndefined();
    expect(value.VIDEO_MAX_SIZE_BYTES).toBe(10737418240);
    expect(value.QUEUE_PORT).toBe(6379);
  });

  it('should apply the documented defaults', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
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
    const { error } = validate({
      VIDEO_UPLOAD_PART_SIZE_BYTES: '6442450944',
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });
});
