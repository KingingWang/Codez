import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { commandAckSchema, type CommandAck } from "@zcode/shared/zcode-protocol-v4";

/** Durable correlation only, never an execution queue. Pending means unknown, not retryable. */
export class CommandLedger {
  constructor(private readonly root: string) {}
  private path(sessionId: string | null, commandId: string): string {
    return join(
      this.root,
      createHash("sha256")
        .update(JSON.stringify([sessionId, commandId]))
        .digest("hex") + ".json",
    );
  }
  async lookup(
    sessionId: string | null,
    commandId: string,
  ): Promise<CommandAck | "unknown" | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path(sessionId, commandId), "utf8"));
      return value === null ? "unknown" : commandAckSchema.parse(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async begin(sessionId: string | null, commandId: string): Promise<boolean> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const file = await open(this.path(sessionId, commandId), "wx", 0o600);
      try {
        await file.writeFile("null");
        await file.sync();
      } finally {
        await file.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }
  async finish(sessionId: string | null, ack: CommandAck): Promise<void> {
    const target = this.path(sessionId, ack.commandId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(commandAckSchema.parse(ack)));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
  }
}
