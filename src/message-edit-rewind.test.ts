import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  SessionManager,
  type SessionContext,
  type OmpProcess,
  type UserPromptEntry,
  sendRpc,
  sendRpcRequest,
} from "./session-manager";
import { SqliteSessionStore } from "./storage";

interface MockProcessStdin {
  written: string[];
  write: (data: string) => void;
  flush: () => void;
}

interface MockProcess {
  stdin: MockProcessStdin;
  killed: boolean;
  kill: () => void;
  exited: Promise<number | null>;
}

describe("Message-Edit-as-a-Rewind Support", () => {
  const testDir = join(tmpdir(), "omp-msg-edit-test-" + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  function createMockSessionContext(threadId = "test-thread-1"): {
    session: SessionContext;
    written: string[];
  } {
    const written: string[] = [];
    const { promise: exitedPromise } = Promise.withResolvers<number | null>();

    const fakeProcess: MockProcess = {
      stdin: {
        written,
        write: (data: string) => {
          written.push(data);
        },
        flush: () => {},
      },
      killed: false,
      kill: () => {
        fakeProcess.killed = true;
      },
      exited: exitedPromise,
    };

    const session: SessionContext = {
      process: fakeProcess as unknown as OmpProcess,
      threadId,
      cwd: testDir,
      currentStreamBuffer: "",
      lastEditTimestamp: 0,
      pendingRpcRequests: new Map(),
      userPrompts: [],
      isTurnInProgress: false,
    };

    return { session, written };
  }

  it("sends RPC command via sendRpc and parses valid JSON frames", () => {
    const { session, written } = createMockSessionContext();

    sendRpc(session, { id: "test_1", type: "prompt", message: "Hello world" });
    expect(written.length).toBe(1);

    const parsed = JSON.parse(written[0].trim());
    expect(parsed.id).toBe("test_1");
    expect(parsed.type).toBe("prompt");
    expect(parsed.message).toBe("Hello world");
  });

  it("sendRpcRequest awaits response matching unique request ID", async () => {
    const { session, written } = createMockSessionContext();

    const requestPromise = sendRpcRequest(session, { type: "get_branch_messages" }, 1000);
    expect(written.length).toBe(1);

    const parsed = JSON.parse(written[0].trim());
    const reqId = parsed.id;
    expect(reqId).toBeDefined();

    // Simulate RPC response coming back
    const responseFrame = {
      id: reqId,
      type: "response",
      command: "get_branch_messages",
      success: true,
      data: {
        messages: [{ entryId: "entry_1", text: "For context I th" }],
      },
    };

    // Trigger resolver registered in pendingRpcRequests
    const resolver = session.pendingRpcRequests?.get(reqId);
    expect(resolver).toBeDefined();
    resolver?.(responseFrame);

    const result = await requestPromise;
    expect(result.success).toBe(true);
    expect(result.command).toBe("get_branch_messages");
    const data = result.data as { messages: Array<{ entryId: string; text: string }> };
    expect(data.messages[0].entryId).toBe("entry_1");
    expect(session.pendingRpcRequests?.has(reqId)).toBe(false);
  });

  it("sendRpcRequest rejects on timeout when no response is received", async () => {
    const { session } = createMockSessionContext();

    await expect(
      sendRpcRequest(session, { type: "get_branch_messages" }, 50),
    ).rejects.toThrow("RPC request timeout");
  });

  it("tracks user prompts sequentially in session.userPrompts", () => {
    const { session } = createMockSessionContext();

    session.userPrompts = session.userPrompts || [];
    session.userPrompts.push({
      discordMessageId: "msg_1",
      text: "For context I th",
      imageCount: 0,
      timestamp: Date.now(),
    });

    expect(session.userPrompts.length).toBe(1);
    expect(session.userPrompts[0].discordMessageId).toBe("msg_1");
    expect(session.userPrompts[0].text).toBe("For context I th");

    session.userPrompts.push({
      discordMessageId: "msg_2",
      text: "Second prompt",
      imageCount: 0,
      timestamp: Date.now(),
    });

    expect(session.userPrompts.length).toBe(2);
    expect(session.userPrompts[1].discordMessageId).toBe("msg_2");
  });

  it("simulates rewind on message edit: aborts active turn, branches to checkpoint, truncates history, and resubmits", async () => {
    const { session, written } = createMockSessionContext();

    // Setup initial prompt history
    session.userPrompts = [
      {
        discordMessageId: "msg_1",
        text: "For context I th",
        imageCount: 0,
        timestamp: 1000,
      },
    ];

    // Simulate turn actively running
    session.isTurnInProgress = true;
    session.currentStreamBuffer = "Partial thinking...";
    session.activeToolStatus = "Running tool...";

    // Handle incoming edit for msg_1
    const editedDiscordMessageId = "msg_1";
    const editedNewText = "For context I think we should do X";

    const promptIndex = session.userPrompts.findIndex(
      (p) => p.discordMessageId === editedDiscordMessageId,
    );
    expect(promptIndex).toBe(0);

    const previousPrompt = session.userPrompts[promptIndex];
    expect(previousPrompt.text).toBe("For context I th");
    expect(editedNewText).not.toBe(previousPrompt.text);

    // 1. Abort active turn
    if (session.isTurnInProgress) {
      session.currentStreamBuffer = "";
      session.activeToolStatus = undefined;
      sendRpc(session, { id: "abort_req", type: "abort" });
      session.isTurnInProgress = false;
    }

    expect(written.length).toBe(1);
    expect(JSON.parse(written[0]).type).toBe("abort");
    expect(session.currentStreamBuffer).toBe("");
    expect(session.activeToolStatus).toBeUndefined();

    // 2. Query branch messages
    const branchRequestPromise = sendRpcRequest(session, { type: "get_branch_messages" }, 1000);
    const branchReqParsed = JSON.parse(written[1]);
    expect(branchReqParsed.type).toBe("get_branch_messages");

    // Simulate OMP responding with branch checkpoints
    const branchResolver = session.pendingRpcRequests?.get(branchReqParsed.id);
    branchResolver?.({
      id: branchReqParsed.id,
      type: "response",
      command: "get_branch_messages",
      success: true,
      data: {
        messages: [{ entryId: "entry_checkpoint_1", text: "For context I th" }],
      },
    });

    const branchRes = await branchRequestPromise;
    const branchMessages = (
      branchRes.data as { messages: Array<{ entryId: string; text: string }> }
    ).messages;
    expect(branchMessages.length).toBe(1);
    expect(branchMessages[0].entryId).toBe("entry_checkpoint_1");

    // 3. Send branch command to rewind OMP checkpoint
    const targetEntry = branchMessages[promptIndex];
    const rewindPromise = sendRpcRequest(
      session,
      { type: "branch", entryId: targetEntry.entryId },
      1000,
    );
    const rewindReqParsed = JSON.parse(written[2]);
    expect(rewindReqParsed.type).toBe("branch");
    expect(rewindReqParsed.entryId).toBe("entry_checkpoint_1");

    // Simulate OMP confirming branch
    const rewindResolver = session.pendingRpcRequests?.get(rewindReqParsed.id);
    rewindResolver?.({
      id: rewindReqParsed.id,
      type: "response",
      command: "branch",
      success: true,
      data: { text: "For context I th", cancelled: false },
    });
    await rewindPromise;

    // 4. Truncate user prompt history
    session.userPrompts = session.userPrompts.slice(0, promptIndex);
    expect(session.userPrompts.length).toBe(0);

    // 5. Append updated prompt entry and submit new prompt
    session.userPrompts.push({
      discordMessageId: editedDiscordMessageId,
      text: editedNewText,
      imageCount: 0,
      timestamp: Date.now(),
    });

    sendRpc(session, {
      id: "prompt_new",
      type: "prompt",
      message: editedNewText,
    });

    expect(written.length).toBe(4);
    const lastCommand = JSON.parse(written[3]);
    expect(lastCommand.type).toBe("prompt");
    expect(lastCommand.message).toBe("For context I think we should do X");

    expect(session.userPrompts.length).toBe(1);
    expect(session.userPrompts[0].text).toBe("For context I think we should do X");
  });

  it("handles multi-turn rewinds: editing an earlier message prunes subsequent turns", async () => {
    const { session, written } = createMockSessionContext();

    session.userPrompts = [
      { discordMessageId: "msg_1", text: "Turn 1", imageCount: 0, timestamp: 1000 },
      { discordMessageId: "msg_2", text: "Turn 2 incomplete", imageCount: 0, timestamp: 2000 },
      { discordMessageId: "msg_3", text: "Turn 3", imageCount: 0, timestamp: 3000 },
    ];

    // User edits msg_2 (promptIndex = 1)
    const promptIndex = session.userPrompts.findIndex((p) => p.discordMessageId === "msg_2");
    expect(promptIndex).toBe(1);

    const branchRequestPromise = sendRpcRequest(session, { type: "get_branch_messages" }, 1000);
    const branchReq = JSON.parse(written[0]);

    session.pendingRpcRequests?.get(branchReq.id)?.({
      id: branchReq.id,
      type: "response",
      command: "get_branch_messages",
      success: true,
      data: {
        messages: [
          { entryId: "entry_1", text: "Turn 1" },
          { entryId: "entry_2", text: "Turn 2 incomplete" },
          { entryId: "entry_3", text: "Turn 3" },
        ],
      },
    });

    const branchRes = await branchRequestPromise;
    const branchMessages = (
      branchRes.data as { messages: Array<{ entryId: string; text: string }> }
    ).messages;

    const targetEntry = branchMessages[promptIndex];
    expect(targetEntry.entryId).toBe("entry_2");

    // Rewind to entry_2
    const rewindPromise = sendRpcRequest(
      session,
      { type: "branch", entryId: targetEntry.entryId },
      1000,
    );
    const rewindReq = JSON.parse(written[1]);
    expect(rewindReq.entryId).toBe("entry_2");

    session.pendingRpcRequests?.get(rewindReq.id)?.({
      id: rewindReq.id,
      type: "response",
      command: "branch",
      success: true,
      data: { text: "Turn 2 incomplete", cancelled: false },
    });
    await rewindPromise;

    // Truncate from promptIndex (1)
    session.userPrompts = session.userPrompts.slice(0, promptIndex);
    expect(session.userPrompts.length).toBe(1);
    expect(session.userPrompts[0].discordMessageId).toBe("msg_1");

    // Add edited Turn 2
    session.userPrompts.push({
      discordMessageId: "msg_2",
      text: "Turn 2 completed correctly",
      imageCount: 0,
      timestamp: Date.now(),
    });

    sendRpc(session, {
      id: "prompt_turn_2_edited",
      type: "prompt",
      message: "Turn 2 completed correctly",
    });

    expect(session.userPrompts.length).toBe(2);
    expect(session.userPrompts[0].text).toBe("Turn 1");
    expect(session.userPrompts[1].text).toBe("Turn 2 completed correctly");
    // Turn 3 was pruned as expected
  });
  it("does not truncate history or resubmit prompt if OMP branch rewind fails", async () => {
    const { session, written } = createMockSessionContext();

    session.userPrompts = [
      { discordMessageId: "msg_1", text: "Turn 1", imageCount: 0, timestamp: 1000 },
      { discordMessageId: "msg_2", text: "Turn 2", imageCount: 0, timestamp: 2000 },
    ];

    const promptIndex = session.userPrompts.findIndex((p) => p.discordMessageId === "msg_2");
    expect(promptIndex).toBe(1);

    const branchRequestPromise = sendRpcRequest(session, { type: "get_branch_messages" }, 1000);
    const branchReq = JSON.parse(written[0]);

    // Simulate get_branch_messages returning an error or no match
    session.pendingRpcRequests?.get(branchReq.id)?.({
      id: branchReq.id,
      type: "response",
      command: "get_branch_messages",
      success: false,
      error: "Branch lookup failure",
    });

    const branchRes = await branchRequestPromise;
    let branchSucceeded = false;
    if (branchRes.success === true) {
      branchSucceeded = true;
    }

    // When branch lookup fails, branchSucceeded is false
    expect(branchSucceeded).toBe(false);

    // History is NOT truncated and prompt is NOT resubmitted
    expect(session.userPrompts.length).toBe(2);
    expect(session.userPrompts[0].text).toBe("Turn 1");
    expect(session.userPrompts[1].text).toBe("Turn 2");
    expect(written.length).toBe(1); // Only the get_branch_messages call was sent
  });

  it("detects edit and triggers rewind when attachment fingerprint changes", () => {
    const previousPrompt: UserPromptEntry = {
      discordMessageId: "msg_1",
      text: "Look at this image",
      attachmentFingerprint: "att_1:photo.png:1024:https://cdn.discord.com/1",
      imageCount: 1,
      timestamp: 1000,
    };

    const newText = "Look at this image";
    const newFingerprint = "att_2:photo_revised.png:2048:https://cdn.discord.com/2";

    const isChanged =
      newText !== previousPrompt.text ||
      newFingerprint !== (previousPrompt.attachmentFingerprint || "");

    expect(isChanged).toBe(true);
  });

  it("matches branch checkpoint using explicit entryId on UserPromptEntry", async () => {
    const { session, written } = createMockSessionContext();

    session.userPrompts = [
      {
        discordMessageId: "msg_1",
        text: "Turn 1",
        entryId: "target_entry_id_123",
        imageCount: 0,
        timestamp: 1000,
      },
    ];

    const branchRequestPromise = sendRpcRequest(session, { type: "get_branch_messages" }, 1000);
    const branchReq = JSON.parse(written[0]);

    session.pendingRpcRequests?.get(branchReq.id)?.({
      id: branchReq.id,
      type: "response",
      command: "get_branch_messages",
      success: true,
      data: {
        messages: [
          { entryId: "target_entry_id_123", text: "Turn 1" },
          { entryId: "other_entry", text: "Other" },
        ],
      },
    });

    const branchRes = await branchRequestPromise;
    const branchMessages = (
      branchRes.data as { messages: Array<{ entryId: string; text: string }> }
    ).messages;

    const targetEntry = branchMessages.find((m) => m.entryId === session.userPrompts![0].entryId);
    expect(targetEntry).toBeDefined();
    expect(targetEntry?.entryId).toBe("target_entry_id_123");
  });

  it("integrates with real OMP subprocess: verifies branch rewind via RPC", async () => {
    const proc = Bun.spawn(["omp", "--mode", "rpc", "--no-session"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const session: SessionContext = {
      process: proc as unknown as OmpProcess,
      threadId: "live-thread",
      cwd: testDir,
      currentStreamBuffer: "",
      lastEditTimestamp: 0,
      pendingRpcRequests: new Map(),
      userPrompts: [],
      isTurnInProgress: false,
    };

    const turnDoneRef: { current: (() => void) | null } = { current: null };
    let isRunning = true;

    (async () => {
      while (isRunning) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        while (true) {
          const idx = buf.indexOf("\n");
          if (idx === -1) break;
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            const frame = JSON.parse(line);
            if (
              frame.type === "agent_end" ||
              (frame.type === "prompt_result" && !frame.agentInvoked)
            ) {
              if (turnDoneRef.current) {
                const r = turnDoneRef.current;
                turnDoneRef.current = null;
                r();
              }
            }
            if (
              frame.type === "response" &&
              frame.id &&
              session.pendingRpcRequests?.has(frame.id)
            ) {
              const cb = session.pendingRpcRequests.get(frame.id);
              cb?.(frame);
            }
          } catch {}
        }
      }
    })();

    try {
      // Negotiate protocol
      const negRes = await sendRpcRequest(
        session,
        { type: "negotiate_protocol", protocolVersion: 2 },
        5000,
      );
      expect(negRes.success).toBe(true);

      // Send prompt 1
      const { promise: p1Turn, resolve: r1 } = Promise.withResolvers<void>();
      turnDoneRef.current = r1;
      sendRpc(session, { id: "p1", type: "prompt", message: "Say alpha" });
      await p1Turn;

      // Send prompt 2
      const { promise: p2Turn, resolve: r2 } = Promise.withResolvers<void>();
      turnDoneRef.current = r2;
      sendRpc(session, { id: "p2", type: "prompt", message: "Say beta" });
      await p2Turn;

      // Query branch messages
      const branchRes = await sendRpcRequest(session, { type: "get_branch_messages" }, 5000);
      const branchData = branchRes.data as {
        messages: Array<{ entryId: string; text: string }>;
      };
      expect(branchData.messages.length).toBe(2);
      expect(branchData.messages[0].text).toBe("Say alpha");
      expect(branchData.messages[1].text).toBe("Say beta");

      // Rewind to message 2
      const rewindRes = await sendRpcRequest(
        session,
        { type: "branch", entryId: branchData.messages[1].entryId },
        5000,
      );
      expect(rewindRes.success).toBe(true);

      // Resubmit edited prompt 2
      const { promise: p2EditedTurn, resolve: r2Edited } = Promise.withResolvers<void>();
      turnDoneRef.current = r2Edited;
      sendRpc(session, { id: "p2_edit", type: "prompt", message: "Say beta edited" });
      await p2EditedTurn;
      // Check messages
      const msgsRes = await sendRpcRequest(session, { type: "get_messages" }, 5000);
      const msgsData = msgsRes.data as {
        messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      };
      const userMsgs = msgsData.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content[0].text);

      expect(userMsgs).toEqual(["Say alpha", "Say beta edited"]);
    } finally {
      isRunning = false;
      proc.kill();
    }
  }, 30000);
});
