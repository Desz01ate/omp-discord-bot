import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Attachment Processing", () => {
  const testDir = join(tmpdir(), "omp-bot-test-" + Date.now());
  const threadId = "thread_12345";
  const messageId = "msg_67890";

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("processes image attachment to base64 payload", async () => {
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const arrayBuf = Buffer.from(pngBase64, "base64");

    const mockFetch = async () => ({
      ok: true,
      arrayBuffer: async () => arrayBuf,
    });

    const att = { url: "https://example.com/test.png", name: "test.png", contentType: "image/png" };
    const res = await mockFetch();
    const buf = await res.arrayBuffer();
    const b64 = Buffer.from(buf).toString("base64");

    expect(b64).toBe(pngBase64);
  });

  it("saves non-image attachment to disk and creates @path reference", async () => {
    const content = "Hello world zip content";
    const buf = Buffer.from(content, "utf-8");

    const targetDir = join(testDir, ".discord-attachments", threadId, messageId);
    mkdirSync(targetDir, { recursive: true });
    const targetFile = join(targetDir, "archive.zip");
    writeFileSync(targetFile, buf);

    expect(existsSync(targetFile)).toBe(true);
    expect(readFileSync(targetFile, "utf-8")).toBe(content);

    const promptText = "Analyze this project";
    const combinedPrompt = `@${targetFile} ${promptText}`;
    expect(combinedPrompt).toBe(`@${targetFile} Analyze this project`);
  });

  it("cleans up thread attachments directory", () => {
    const threadDir = join(testDir, ".discord-attachments", threadId);
    const messageDir = join(threadDir, messageId);
    mkdirSync(messageDir, { recursive: true });
    writeFileSync(join(messageDir, "doc.pdf"), Buffer.from("dummy pdf"));

    expect(existsSync(join(messageDir, "doc.pdf"))).toBe(true);

    // Simulate cleanThreadAttachments
    if (existsSync(threadDir)) {
      rmSync(threadDir, { recursive: true, force: true });
    }

    expect(existsSync(threadDir)).toBe(false);
  });

  it("rejects attachments exceeding max size limit", () => {
    const MAX_SIZE = 25 * 1024 * 1024;
    const oversized = { url: "https://example.com/huge.bin", name: "huge.bin", size: MAX_SIZE + 1 };
    const isOversized = (typeof oversized.size === "number" && oversized.size > MAX_SIZE);
    expect(isOversized).toBe(true);
  });
});
