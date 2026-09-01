export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

/* Phase 03 — videos */

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super(
      'CHANNEL_NOT_FOUND',
      404,
      'Channel not found for the authenticated user',
    );
  }
}

/**
 * Also raised when a public route reaches a video that is not `ready`.
 *
 * Deliberate: if a draft answered with a distinct status, its existence could
 * be confirmed by probing public identifiers. Absence and not-being-ready are
 * indistinguishable from outside, and the owner has an authenticated route to
 * see the real status.
 */
export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super('VIDEO_NOT_OWNED', 403, 'Video belongs to another channel');
  }
}

export class InvalidVideoStateException extends DomainException {
  constructor(detail: string) {
    super(
      'INVALID_VIDEO_STATE',
      409,
      `Video is not in a valid state for this operation: ${detail}`,
    );
  }
}

export class UnsupportedContentTypeException extends DomainException {
  constructor(contentType: string) {
    super(
      'UNSUPPORTED_CONTENT_TYPE',
      400,
      `Content type is not an accepted video type: ${contentType}`,
    );
  }
}

export class FileTooLargeException extends DomainException {
  constructor(maxBytes: number) {
    super(
      'FILE_TOO_LARGE',
      400,
      `File exceeds the maximum allowed size of ${maxBytes} bytes`,
    );
  }
}

export class ThumbnailNotAvailableException extends DomainException {
  constructor() {
    super(
      'THUMBNAIL_NOT_AVAILABLE',
      404,
      'Thumbnail is not available for this video',
    );
  }
}
