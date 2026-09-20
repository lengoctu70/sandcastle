import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Atomic same-directory file replacement (F024/F064).
 *
 * `atomicWriteFile` is the shared write seam for every durable Sandcastle
 * record — `.sandcastle/settings.json` (ProjectSettings.ts) and
 * `.sandcastle/recovery/issue-<N>.json` (recovery.ts):
 *
 *   1. `data` is written to a unique temporary file in the SAME directory as
 *      `path` (same filesystem, so the rename below never copies).
 *   2. The temporary file is `fsync`ed before it is renamed — after this
 *      resolves, the bytes are durable on the supported platforms.
 *   3. `rename(2)` atomically replaces `path`: readers observe either the
 *      complete old document or the complete new one, never a truncated
 *      intermediate file. Same-directory rename is atomic on POSIX; Node's
 *      `fs.rename` uses `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING` on
 *      Windows, which replaces same-volume targets atomically.
 *   4. The parent directory is `fsync`ed best-effort so the rename itself is
 *      durable (a no-op on platforms that cannot sync directories).
 *
 * On failure the temporary file is removed and `path` is left untouched —
 * the previously written document survives as it was. Temporary files are
 * named `<name>.<pid>.<random>.tmp` so a leftover from a crashed process is
 * recognizable and never collides with a later write or a `*.json` listing.
 *
 * The caller is responsible for creating the parent directory first.
 */
export const atomicWriteFile = async (
  path: string,
  data: string | Uint8Array,
): Promise<void> => {
  const dir = dirname(path);
  const tmpPath = join(
    dir,
    `${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmpPath, "w");
    await handle.writeFile(data);
    // Flush the file's bytes before the rename publishes them.
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmpPath, path);
    // Flush the directory entry itself so the rename survives a crash.
    // Not every supported platform can sync a directory — best-effort.
    await open(dir)
      .then(async (dirHandle) => {
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      })
      .catch(() => {});
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
};
