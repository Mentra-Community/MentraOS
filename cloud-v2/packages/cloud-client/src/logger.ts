/**
 * @fileoverview The logging interface and a no-op default.
 *
 * One logger is owned by `CloudClient` and passed down to every module, so a
 * host can route all cloud-client logs wherever it wants. The interface is kept
 * minimal (four levels, an optional structured-meta object) so it is trivial to
 * adapt any host logger to it.
 *
 * Security: never pass a token, refresh token, or encryption key into any of
 * these calls. The library does not log credentials, and neither should hosts.
 *
 * See docs/issues/004-cloud-client/design.md.
 */

/** The shape a host must provide (or accept the no-op below). */
export interface Logger {
  debug(msg: string, meta?: object): void;
  info(msg: string, meta?: object): void;
  warn(msg: string, meta?: object): void;
  error(msg: string, meta?: object): void;
}

/**
 * The default logger when a host supplies none: it drops everything.
 *
 * A silent default means the library never prints to a host's console
 * uninvited; a host opts into logging by passing its own `Logger`.
 */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
