/**
 * DI tokens for the two S3 clients.
 *
 * They differ only in `endpoint`. The internal one addresses storage by its
 * Compose service name and is used for server-to-server calls; the public one
 * is used to sign every URL that will be handed to a client outside the Docker
 * network. See TD-08 and ISS-02.
 */
export const STORAGE_CLIENTS = {
  INTERNAL: 'STORAGE_INTERNAL_CLIENT',
  PUBLIC: 'STORAGE_PUBLIC_CLIENT',
} as const;
