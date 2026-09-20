import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteFile } from "./atomicFile.js";

const makeDir = () => mkdtemp(join(tmpdir(), "atomic-file-"));

const tmpLeftovers = (dir: string) =>
  readdir(dir).then((names) => names.filter((n) => n.endsWith(".tmp")));

describe("atomicWriteFile", () => {
  it("creates the file where none existed and leaves no temp behind", async () => {
    const dir = await makeDir();
    const path = join(dir, "doc.json");

    await atomicWriteFile(path, '{"a":1}\n');

    expect(await readFile(path, "utf-8")).toBe('{"a":1}\n');
    expect(await tmpLeftovers(dir)).toEqual([]);
  });

  it("replaces an existing file completely", async () => {
    const dir = await makeDir();
    const path = join(dir, "doc.json");
    await writeFile(path, '{"a":1}\n');

    await atomicWriteFile(path, '{"a":2,"b":"new"}\n');

    expect(await readFile(path, "utf-8")).toBe('{"a":2,"b":"new"}\n');
    expect(await tmpLeftovers(dir)).toEqual([]);
  });

  it("readers only ever observe a complete old or complete new document", async () => {
    const dir = await makeDir();
    const path = join(dir, "doc.json");
    // A large payload widens the window in which an in-place write would be
    // observed truncated — with rename-based replacement it is impossible.
    const pad = "x".repeat(128 * 1024);
    let done = false;

    const writer = (async () => {
      for (let i = 0; i < 40; i++) {
        await atomicWriteFile(path, JSON.stringify({ seq: i, pad }));
      }
      done = true;
    })();
    const reader = (async () => {
      let reads = 0;
      while (!done) {
        let content: string;
        try {
          content = await readFile(path, "utf-8");
        } catch {
          continue; // not created yet — never a partial file
        }
        const parsed: unknown = JSON.parse(content); // throws on truncation
        expect(parsed).toMatchObject({ pad });
        reads++;
      }
      expect(reads).toBeGreaterThan(0);
    })();

    await Promise.all([writer, reader]);
    expect(await tmpLeftovers(dir)).toEqual([]);
  });

  it("a failure at the rename seam preserves the target and cleans the temp file", async () => {
    const dir = await makeDir();
    // An existing non-empty directory at the target path: the temp write
    // succeeds, then rename(tmp → dir) must fail (ENOTEMPTY/EEXIST).
    const path = join(dir, "doc.json");
    await mkdir(join(path, "inside"), { recursive: true });

    await expect(atomicWriteFile(path, "{}")).rejects.toThrow();

    // The "previous document" (here, the directory) is untouched.
    expect((await stat(path)).isDirectory()).toBe(true);
    expect(await tmpLeftovers(dir)).toEqual([]);
  });

  it("a failure at the create seam preserves the previous document", async () => {
    const dir = await makeDir();
    const path = join(dir, "doc.json");
    const before = '{"old":true}\n';
    await writeFile(path, before);

    // If the environment cannot enforce an unwritable directory (running as
    // root, or a platform without POSIX perms), the fault cannot be injected —
    // probe first and let the test stand down rather than assert nothing.
    await chmod(dir, 0o555);
    const writable = await writeFile(join(dir, ".probe"), "x").then(
      async () => {
        await chmod(dir, 0o755);
        return true;
      },
      async () => {
        return false;
      },
    );
    try {
      if (writable) return;

      await expect(atomicWriteFile(path, "{}")).rejects.toThrow();
      expect(await readFile(path, "utf-8")).toBe(before);
      expect(await tmpLeftovers(dir)).toEqual([]);
    } finally {
      await chmod(dir, 0o755).catch(() => {});
    }
  });
});
