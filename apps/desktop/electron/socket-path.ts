/**
 * v0.0.9 pass 4 (rt's capture): a unix socket path must fit macOS's sun_path, 104 bytes with its NUL. An over-long one
 * never binds, and under a long userData the launcher's did not: the agent silently lost `terminal`. Every socket
 * family checks its path before it listens and fails LOUDLY, naming the socket and what to do, instead of leaving a
 * tool that is quietly missing. (Moving the sockets to a short folder is the v0.0.10 fix; this is the guard.)
 */
export const MAX_SOCKET_PATH_BYTES = 103

export class SocketPathTooLongError extends Error {
  override name = 'SocketPathTooLongError'
}

/** Throws a SocketPathTooLongError when `file` cannot be bound as a unix socket on macOS. */
export function assertSocketPathFits(file: string, socket: string): void {
  const bytes = Buffer.byteLength(file, 'utf8')

  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new SocketPathTooLongError(
      `${socket} cannot start: its socket path is ${bytes} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte limit of a ` +
        `macOS socket (${file}). Move the app's data folder to a shorter path, or run iclone os from its default location.`
    )
  }
}
