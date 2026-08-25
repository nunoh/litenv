import { chmod, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { EnvTransport } from "./types.js";

export class LocalTransport implements EnvTransport {
  constructor(readonly file: string) {}

  async read(): Promise<string> {
    try {
      return await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  async write(content: string): Promise<void> {
    const temporary = path.join(path.dirname(this.file), `.${path.basename(this.file)}.litenv-${randomUUID()}`);
    let mode: number | undefined;
    try {
      mode = (await stat(this.file)).mode;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    try {
      const handle = await open(temporary, "wx", mode ?? 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (mode !== undefined) await chmod(temporary, mode);
      await rename(temporary, this.file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
