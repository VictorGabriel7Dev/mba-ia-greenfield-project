import { PUBLIC_ID_LENGTH, generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('produces an identifier of exactly the declared length', () => {
    for (let i = 0; i < 100; i++) {
      expect(generatePublicId()).toHaveLength(PUBLIC_ID_LENGTH);
    }
  });

  it('fits the column width declared in the migration', () => {
    // videos.public_id is varchar(16). A generator that outgrew it would fail
    // on insert, not here, and only for the videos created after the change.
    expect(PUBLIC_ID_LENGTH).toBeLessThanOrEqual(16);
  });

  it('uses only URL-safe characters', () => {
    // base64 and base64url produce strings that look identical at a glance;
    // the difference is `+`, `/` and `=`, which need escaping in a path and
    // would only break at routing time.
    for (let i = 0; i < 1000; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('never emits the standard base64 characters', () => {
    const sample = Array.from({ length: 2000 }, () => generatePublicId()).join(
      '',
    );

    expect(sample).not.toContain('+');
    expect(sample).not.toContain('/');
    expect(sample).not.toContain('=');
  });

  it('does not repeat across ten thousand draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      seen.add(generatePublicId());
    }

    expect(seen.size).toBe(10_000);
  });
});
