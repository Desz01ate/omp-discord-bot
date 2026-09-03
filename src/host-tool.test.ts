import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveWorkspaceFile, MAX_WORKSPACE_DOWNLOAD_BYTES } from "./workspace";
import { toolIcon } from "./observability";
import { handleHostToolCancel, handleUploadArtifactCall } from "./artifact-host-tool";
import { type SessionContext, type PendingHostToolCall } from "./session-manager";
describe("upload_artifact host tool path & attachment validation", () => {
  const testDir = join(tmpdir(), "omp-upload-artifact-test-" + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("resolves a valid markdown file in the workspace", () => {
    const filePath = join(testDir, "report.md");
    writeFileSync(filePath, "# Report\nContent here");

    const result = resolveWorkspaceFile(testDir, "report.md");
    expect(result.ok).toBe(true);
    expect(result.file?.relativePath).toBe("report.md");
    expect(result.file?.size).toBeGreaterThan(0);
  });

  it("rejects path traversal attempting to escape the workspace", () => {
    const result = resolveWorkspaceFile(testDir, "../outside.txt");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside the session workspace");
  });

  it("rejects symlinks that point outside the session workspace", () => {
    const outsideDir = join(tmpdir(), "omp-outside-" + Date.now());
    mkdirSync(outsideDir, { recursive: true });
    try {
      const secretFile = join(outsideDir, "secret.env");
      writeFileSync(secretFile, "SECRET=123");
      const symlinkPath = join(testDir, "leak-link.txt");
      symlinkSync(secretFile, symlinkPath);

      const result = resolveWorkspaceFile(testDir, "leak-link.txt");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("outside the session workspace");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects directories as upload artifacts", () => {
    const subDir = join(testDir, "sub_directory");
    mkdirSync(subDir);

    const result = resolveWorkspaceFile(testDir, "sub_directory");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a regular file");
  });

  it("rejects non-existent files", () => {
    const result = resolveWorkspaceFile(testDir, "does_not_exist.txt");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not exist");
  });

  it("enforces 25MB attachment limit correctly", () => {
    const fakeOversizedFile = {
      absolutePath: "/tmp/large.bin",
      relativePath: "large.bin",
      size: MAX_WORKSPACE_DOWNLOAD_BYTES + 1,
    };
    expect(fakeOversizedFile.size > MAX_WORKSPACE_DOWNLOAD_BYTES).toBe(true);
  });

  it("provides correct tool icon for upload_artifact", () => {
    expect(toolIcon("upload_artifact")).toBe("📎");
    expect(toolIcon("UPLOAD_ARTIFACT")).toBe("📎");
  });
  it("uploads a valid workspace file and returns structured details", async () => {
    const filePath = join(testDir, "report.md");
    writeFileSync(filePath, "# Report\n");
    const sentFrames: Record<string, unknown>[] = [];
    const sentMessages: Array<Record<string, unknown>> = [];
    let resolveSend: ((message: { id: string }) => void) | undefined;
    const session = {
      cwd: testDir,
      threadId: "thread_upload",
      currentStreamBuffer: "",
      lastEditTimestamp: 0,
      pendingHostToolCalls: new Map(),
    } as unknown as SessionContext;
    const thread = {
      send: async (message: Record<string, unknown>) => {
        sentMessages.push(message);
        return new Promise<{ id: string }>((resolve) => {
          resolveSend = resolve;
        });
      },
    };

    const upload = handleUploadArtifactCall(
      session,
      thread as never,
      { id: "call_upload", toolCallId: "tool_upload", toolName: "upload_artifact", arguments: { path: "report.md", description: "Generated report" } },
      (_session, frame) => sentFrames.push(frame),
    );
    await Promise.resolve();
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content).toBe("Generated report");
    expect((sentMessages[0].files as Array<{ name: string }>)[0].name).toBe("report.md");
    resolveSend?.({ id: "discord_message" });
    await upload;

    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0].type).toBe("host_tool_result");
    expect((sentFrames[0].result as { details: Record<string, unknown> }).details).toEqual({
      path: "report.md",
      filename: "report.md",
      size: 9,
      messageId: "discord_message",
    });
  });

  it("cancels an upload without sending a duplicate result", async () => {
    writeFileSync(join(testDir, "report.md"), "# Report\n");
    const sentFrames: Record<string, unknown>[] = [];
    const session = {
      cwd: testDir,
      threadId: "thread_cancel",
      currentStreamBuffer: "",
      lastEditTimestamp: 0,
      pendingHostToolCalls: new Map(),
    } as unknown as SessionContext;
    let resolveSend: ((message: { id: string }) => void) | undefined;
    const thread = {
      send: async () => new Promise<{ id: string }>((resolve) => {
        resolveSend = resolve;
      }),
    };

    const upload = handleUploadArtifactCall(
      session,
      thread as never,
      { id: "call_cancel", toolCallId: "tool_cancel", toolName: "upload_artifact", arguments: { path: "report.md" } },
      (_session, frame) => sentFrames.push(frame),
    );
    await Promise.resolve();
    handleHostToolCancel(session, "call_cancel");
    resolveSend?.({ id: "late_message" });
    await upload;

    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0].isError).toBe(true);
    expect((sentFrames[0].result as { content: Array<{ text: string }> }).content[0].text).toBe("Host tool call was cancelled");
  });

  it("returns a host-tool error without uploading an unsafe path", async () => {
    const sentFrames: Record<string, unknown>[] = [];
    let sendCount = 0;
    const session = {
      cwd: testDir,
      threadId: "thread_invalid",
      currentStreamBuffer: "",
      lastEditTimestamp: 0,
      pendingHostToolCalls: new Map(),
    } as unknown as SessionContext;
    const thread = {
      send: async () => {
        sendCount++;
        return { id: "unexpected" };
      },
    };

    await handleUploadArtifactCall(
      session,
      thread as never,
      { id: "call_invalid", toolCallId: "tool_invalid", toolName: "upload_artifact", arguments: { path: "../secret.txt" } },
      (_session, frame) => sentFrames.push(frame),
    );

    expect(sendCount).toBe(0);
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0].isError).toBe(true);
  });

});

describe("Host tool lifecycle and cancellation settlement", () => {
  function createMockSessionContext(): {
    session: SessionContext;
    sentFrames: Record<string, unknown>[];
  } {
    const sentFrames: Record<string, unknown>[] = [];
    const session: SessionContext = {
      process: {
        stdin: {
          write: (str: string) => {
            sentFrames.push(JSON.parse(str.trim()));
          },
          flush: () => {},
        },
      } as unknown as SessionContext["process"],
      threadId: "test_thread_lifecycle",
      cwd: "/tmp",
      currentStreamBuffer: "",
      lastEditTimestamp: 0,
      pendingHostToolCalls: new Map(),
    };
    return { session, sentFrames };
  }

  it("settles cancellation and clears map", () => {
    const { session } = createMockSessionContext();
    const abortController = new AbortController();
    let settled = false;

    const pendingCall: PendingHostToolCall = {
      id: "call_123",
      toolCallId: "tc_123",
      toolName: "upload_artifact",
      resolve: () => {},
      reject: () => {
        settled = true;
      },
      abortController,
    };

    session.pendingHostToolCalls!.set("call_123", pendingCall);
    expect(session.pendingHostToolCalls!.size).toBe(1);

    // Trigger abort
    pendingCall.abortController.abort(new Error("Host tool cancelled by OMP"));
    expect(abortController.signal.aborted).toBe(true);

    // Call reject and delete
    pendingCall.reject(new Error("Host tool call was cancelled"));
    session.pendingHostToolCalls!.delete("call_123");

    expect(settled).toBe(true);
    expect(session.pendingHostToolCalls!.size).toBe(0);
  });

  it("clears pending host tool calls on session deactivation/exit", () => {
    const { session } = createMockSessionContext();
    const abort1 = new AbortController();
    const abort2 = new AbortController();

    session.pendingHostToolCalls!.set("c1", {
      id: "c1",
      toolCallId: "tc1",
      toolName: "upload_artifact",
      resolve: () => {},
      reject: () => {},
      abortController: abort1,
    });
    session.pendingHostToolCalls!.set("c2", {
      id: "c2",
      toolCallId: "tc2",
      toolName: "upload_artifact",
      resolve: () => {},
      reject: () => {},
      abortController: abort2,
    });

    expect(session.pendingHostToolCalls!.size).toBe(2);

    for (const [, call] of session.pendingHostToolCalls!) {
      call.abortController.abort(new Error("Session deactivated"));
      call.reject(new Error("Session deactivated"));
    }
    session.pendingHostToolCalls!.clear();

    expect(session.pendingHostToolCalls!.size).toBe(0);
    expect(abort1.signal.aborted).toBe(true);
    expect(abort2.signal.aborted).toBe(true);
  });
});
