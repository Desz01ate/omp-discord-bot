import { describe, it, expect, beforeEach } from "bun:test";
import {
  recordUserTurnCheckpoint,
  recordAssistantMessage,
  syncCheckpointsWithBranchMessages,
  findCheckpointIndex,
  pruneCheckpoints,
  waitForTurnToStop,
  sendRpcRequest,
  resolvePendingRpcResponse,
  rejectPendingRpcError,
  cleanupCheckpointsMessages,
  handleMessageEditAsRewind,
  type TurnCheckpoint,
  type RewindContext,
} from "./rewind";
import type { SessionContext } from "./session-manager";
import { InMemorySessionStore } from "./storage/memory";
import { SessionManager } from "./session-manager";
import type { Message, ThreadChannel } from "discord.js";

function createMockSession(threadId = "test_thread"): SessionContext {
  const stdinWrites: string[] = [];
  const mockProcess = {
    stdin: {
      write: (data: string) => {
        stdinWrites.push(data);
      },
      flush: () => {},
    },
    kill: () => {},
  };

  return {
    process: mockProcess as unknown as SessionContext["process"],
    threadId,
    cwd: "/tmp",
    currentStreamBuffer: "",
    lastEditTimestamp: 0,
    checkpoints: [],
    pendingRpcRequests: new Map(),
    isRunning: false,
    isRewinding: false,
  };
}

describe("Rewind & Checkpoints Unit Tests", () => {
  it("records user turn checkpoints correctly and updates duplicates", () => {
    const session = createMockSession();

    const cp1 = recordUserTurnCheckpoint(session, "msg_1", "Hello world");
    expect(session.checkpoints?.length).toBe(1);
    expect(cp1.discordMessageId).toBe("msg_1");
    expect(cp1.promptText).toBe("Hello world");

    const cp2 = recordUserTurnCheckpoint(session, "msg_2", "Second turn");
    expect(session.checkpoints?.length).toBe(2);
    expect(cp2.discordMessageId).toBe("msg_2");

    // Updating existing message ID
    const cpUpdated = recordUserTurnCheckpoint(session, "msg_1", "Hello updated");
    expect(session.checkpoints?.length).toBe(2);
    expect(cpUpdated.promptText).toBe("Hello updated");
  });

  it("records assistant messages to the active turn checkpoint", () => {
    const session = createMockSession();
    recordUserTurnCheckpoint(session, "msg_1", "Prompt 1");

    recordAssistantMessage(session, "bot_msg_1");
    recordAssistantMessage(session, "bot_msg_2");
    // Duplicate message ID should not be added twice
    recordAssistantMessage(session, "bot_msg_1");

    expect(session.checkpoints?.[0].assistantMessageIds).toEqual(["bot_msg_1", "bot_msg_2"]);

    // Next turn gets its own assistant messages
    recordUserTurnCheckpoint(session, "msg_2", "Prompt 2");
    recordAssistantMessage(session, "bot_msg_3");
    expect(session.checkpoints?.[1].assistantMessageIds).toEqual(["bot_msg_3"]);
  });

  it("synchronizes checkpoints with OMP branch messages and prunes excess", () => {
    const session = createMockSession();
    recordUserTurnCheckpoint(session, "msg_1", "Prompt 1");
    recordUserTurnCheckpoint(session, "msg_2", "Prompt 2");
    recordUserTurnCheckpoint(session, "msg_3", "Prompt 3");

    // Normal sync with 3 messages
    syncCheckpointsWithBranchMessages(session, [
      { entryId: "e1", text: "Prompt 1" },
      { entryId: "e2", text: "Prompt 2" },
      { entryId: "e3", text: "Prompt 3" },
    ]);

    expect(session.checkpoints?.[0].entryId).toBe("e1");
    expect(session.checkpoints?.[1].entryId).toBe("e2");
    expect(session.checkpoints?.[2].entryId).toBe("e3");

    // Sync when OMP transcript rolled back (e.g. undo pruned turn 3)
    syncCheckpointsWithBranchMessages(session, [
      { entryId: "e1", text: "Prompt 1" },
      { entryId: "e2", text: "Prompt 2" },
    ]);
    expect(session.checkpoints?.length).toBe(2);
    expect(session.checkpoints?.[1].entryId).toBe("e2");
  });

  it("synchronizes checkpoints correctly even with intervening slash commands", () => {
    const session = createMockSession();
    recordUserTurnCheckpoint(session, "msg_1", "Hello world");
    recordUserTurnCheckpoint(session, "msg_2", "Second question");

    syncCheckpointsWithBranchMessages(session, [
      { entryId: "e1", text: "Hello world" },
      { entryId: "cmd_1", text: "/model gpt-5.5" },
      { entryId: "cmd_2", text: "/fast on" },
      { entryId: "e2", text: "Second question" },
    ]);

    expect(session.checkpoints?.length).toBe(2);
    expect(session.checkpoints?.[0].entryId).toBe("e1");
    expect(session.checkpoints?.[1].entryId).toBe("e2");
  });

  it("rejects and cleans up immediately if sendRpcFn throws synchronously", async () => {
    const session = createMockSession();
    const errorSend = () => {
      throw new Error("Broken pipe");
    };

    await expect(
      sendRpcRequest(session, { type: "test" }, 5000, errorSend),
    ).rejects.toThrow("Broken pipe");

    expect(session.pendingRpcRequests?.size).toBe(0);
  });

  it("finds checkpoint index and prunes checkpoints correctly", () => {
    const session = createMockSession();
    recordUserTurnCheckpoint(session, "msg_1", "Turn 1");
    recordUserTurnCheckpoint(session, "msg_2", "Turn 2");
    recordUserTurnCheckpoint(session, "msg_3", "Turn 3");

    expect(findCheckpointIndex(session, "msg_2")).toBe(1);
    expect(findCheckpointIndex(session, "non_existent")).toBe(-1);

    const removed = pruneCheckpoints(session, 1);
    expect(removed.length).toBe(2);
    expect(removed[0].discordMessageId).toBe("msg_2");
    expect(removed[1].discordMessageId).toBe("msg_3");
    expect(session.checkpoints?.length).toBe(1);
    expect(session.checkpoints?.[0].discordMessageId).toBe("msg_1");
  });

  it("waitForTurnToStop resolves when isRunning is false or becomes false", async () => {
    const session = createMockSession();
    session.isRunning = false;
    expect(await waitForTurnToStop(session, 100)).toBe(true);

    session.isRunning = true;
    queueMicrotask(() => {
      session.isRunning = false;
    });

    const stopped = await waitForTurnToStop(session, 500);
    expect(stopped).toBe(true);
  });

  it("handles sendRpcRequest, resolution, and rejection", async () => {
    const session = createMockSession();
    const commandLog: Record<string, unknown>[] = [];
    const mockSend = (_s: SessionContext, cmd: Record<string, unknown>) => {
      commandLog.push(cmd);
    };

    const reqPromise = sendRpcRequest<{ ok: boolean }>(
      session,
      { type: "test_cmd", foo: "bar" },
      1000,
      mockSend,
    );

    expect(commandLog.length).toBe(1);
    const sentId = commandLog[0].id as string;
    expect(typeof sentId).toBe("string");

    // Resolve via response frame
    const resolved = resolvePendingRpcResponse(session, {
      id: sentId,
      type: "response",
      command: "test_cmd",
      success: true,
      data: { ok: true },
    });
    expect(resolved).toBe(true);

    const res = await reqPromise;
    expect(res.ok).toBe(true);

    // Test rejection
    const failPromise = sendRpcRequest(session, { type: "fail_cmd" }, 1000, mockSend);
    const failId = commandLog[1].id as string;

    rejectPendingRpcError(session, failId, "Something broke");
    await expect(failPromise).rejects.toThrow("Something broke");
  });

  it("cleans up assistant messages across checkpoints", async () => {
    const deletedIds: string[] = [];
    const mockThread = {
      messages: {
        cache: new Map<string, unknown>(),
        fetch: async (id: string) => ({
          id,
          delete: async () => {
            deletedIds.push(id);
          },
        }),
      },
    } as unknown as ThreadChannel;

    const checkpoints: TurnCheckpoint[] = [
      {
        discordMessageId: "u1",
        promptText: "t1",
        timestamp: Date.now(),
        assistantMessageIds: ["a1", "a2"],
      },
      {
        discordMessageId: "u2",
        promptText: "t2",
        timestamp: Date.now(),
        assistantMessageIds: ["a3"],
      },
    ];

    await cleanupCheckpointsMessages(mockThread, checkpoints);
    expect(deletedIds).toEqual(["a1", "a2", "a3"]);
  });

  it("cleans up assistant messages using bulkDelete when supported", async () => {
    let bulkDeletedIds: string[] = [];
    const mockThread = {
      bulkDelete: async (ids: string[]) => {
        bulkDeletedIds = ids;
      },
      messages: {
        cache: new Map(),
      },
    } as unknown as ThreadChannel;

    const checkpoints: TurnCheckpoint[] = [
      {
        discordMessageId: "u1",
        promptText: "t1",
        timestamp: Date.now(),
        assistantMessageIds: ["a1", "a2", "a1"],
      },
    ];

    await cleanupCheckpointsMessages(mockThread, checkpoints);
    expect(bulkDeletedIds).toEqual(["a1", "a2"]);
  });
});

describe("handleMessageEditAsRewind Orchestration", () => {
  let store: InMemorySessionStore;
  let sessionManager: SessionManager;
  let session: SessionContext;
  let sentRpcCommands: Record<string, unknown>[];
  let channelMessages: Array<{
    id: string;
    content: string;
    delete: () => Promise<void>;
    edit: (upd: unknown) => Promise<unknown>;
  }>;
  let threadNameUpdated: string | null;

  beforeEach(async () => {
    store = new InMemorySessionStore();
    sessionManager = new SessionManager({ store });
    await sessionManager.init();

    sentRpcCommands = [];
    channelMessages = [];
    threadNameUpdated = null;

    session = createMockSession("th_123");
    session.sessionId = "sess_old";
    session.sessionFile = "/tmp/sess_old.jsonl";
    await sessionManager.register(session);
  });

  function createMockThread(): ThreadChannel {
    return {
      id: "th_123",
      isThread: () => true,
      send: async (payload: unknown) => {
        const id = `msg_${Date.now()}_${Math.random()}`;
        let content = "";
        if (typeof payload === "string") {
          content = payload;
        } else if (payload && typeof payload === "object" && "content" in payload && typeof payload.content === "string") {
          content = payload.content;
        }
        const msgObj = {
          id,
          content,
          delete: async () => {
            const idx = channelMessages.findIndex((m) => m.id === id);
            if (idx !== -1) channelMessages.splice(idx, 1);
          },
          edit: async (upd: unknown) => {
            if (typeof upd === "string") {
              msgObj.content = upd;
            } else if (upd && typeof upd === "object" && "content" in upd && typeof upd.content === "string") {
              msgObj.content = upd.content;
            }
            return msgObj;
          },
        };
        channelMessages.push(msgObj);
        return msgObj as unknown as Message;
      },
      messages: {
        cache: new Map(),
        fetch: async (id: string) => {
          const found = channelMessages.find((m) => m.id === id);
          if (found) return found as unknown as Message;
          return {
            id,
            delete: async () => {},
          } as unknown as Message;
        },
      },
    } as unknown as ThreadChannel;
  }

  it("ignores edits from bots or unauthorized users", async () => {
    const thread = createMockThread();
    const context: RewindContext = {
      sessionManager,
      isUserAllowed: (id) => id === "allowed_user",
      extractMessagePrompt: async () => ({ text: "test", images: [] }),
      startTyping: () => {},
      sendRpc: () => {},
    };

    const botMessage = {
      id: "m_bot",
      author: { bot: true, id: "bot_1" },
      channel: thread,
    } as unknown as Message;

    const unauthMessage = {
      id: "m_unauth",
      author: { bot: false, id: "hacker" },
      channel: thread,
    } as unknown as Message;

    expect(await handleMessageEditAsRewind(botMessage, botMessage, context)).toBe(false);
    expect(await handleMessageEditAsRewind(unauthMessage, unauthMessage, context)).toBe(false);
  });

  it("ignores edits when content did not change", async () => {
    const thread = createMockThread();
    recordUserTurnCheckpoint(session, "msg_1", "Original text");

    const context: RewindContext = {
      sessionManager,
      isUserAllowed: () => true,
      extractMessagePrompt: async () => ({ text: "Original text", images: [] }),
      startTyping: () => {},
      sendRpc: () => {},
    };

    const message = {
      id: "msg_1",
      author: { bot: false, id: "user_1" },
      channel: thread,
      content: "Original text",
      attachments: new Map(),
    } as unknown as Message;

    expect(await handleMessageEditAsRewind(message, message, context)).toBe(false);
  });

  it("ignores edits when content did not change even with attachments", async () => {
    const thread = createMockThread();
    recordUserTurnCheckpoint(session, "msg_1", "Original text");

    const context: RewindContext = {
      sessionManager,
      isUserAllowed: () => true,
      extractMessagePrompt: async () => ({ text: "Original text", images: [] }),
      startTyping: () => {},
      sendRpc: () => {},
    };

    const messageWithAttachment = {
      id: "msg_1",
      author: { bot: false, id: "user_1" },
      channel: thread,
      content: "Original text",
      attachments: new Map([["att_1", { url: "https://example.com/img.png" }]]),
    } as unknown as Message;

    expect(await handleMessageEditAsRewind(messageWithAttachment, messageWithAttachment, context)).toBe(false);
  });

  it("halts rewind safely if in-flight turn cannot be stopped in time", async () => {
    const thread = createMockThread();
    recordUserTurnCheckpoint(session, "msg_1", "Prompt 1");
    session.isRunning = true;

    const context: RewindContext = {
      sessionManager,
      isUserAllowed: () => true,
      extractMessagePrompt: async () => ({ text: "Prompt 1 Edited", images: [] }),
      startTyping: () => {},
      sendRpc: () => {
        // Intentionally keep isRunning = true
      },
      abortTimeoutMs: 100,
    };

    const editedMessage = {
      id: "msg_1",
      author: { bot: false, id: "user_1" },
      channel: thread,
      content: "Prompt 1 Edited",
      attachments: new Map(),
      react: async () => {},
    } as unknown as Message;

    const result = await handleMessageEditAsRewind(editedMessage, editedMessage, context);
    expect(result).toBe(false);
    expect(session.isRewinding).toBe(false);
  });

  it("rewinds to checkpoint, deletes orphaned assistant messages, branches, and resubmits", async () => {
    const thread = createMockThread();
    recordUserTurnCheckpoint(session, "msg_1", "Prompt 1");
    recordAssistantMessage(session, "bot_resp_1");
    recordUserTurnCheckpoint(session, "msg_2", "Prompt 2");
    recordAssistantMessage(session, "bot_resp_2");

    // Session has 2 checkpoints
    expect(session.checkpoints?.length).toBe(2);

    const context: RewindContext = {
      sessionManager,
      isUserAllowed: () => true,
      extractMessagePrompt: async (_s, m) => ({ text: m.content, images: [] }),
      startTyping: () => {},
      updateThreadNameFromPrompt: async (_t, name) => {
        threadNameUpdated = name;
      },
      sendRpc: (s, cmd) => {
        sentRpcCommands.push(cmd);
        // Respond via microtask
        queueMicrotask(() => {
          if (cmd.type === "get_branch_messages") {
            resolvePendingRpcResponse(s, {
              id: cmd.id,
              type: "response",
              command: "get_branch_messages",
              success: true,
              data: {
                messages: [
                  { entryId: "e1", text: "Prompt 1" },
                  { entryId: "e2", text: "Prompt 2" },
                ],
              },
            });
          } else if (cmd.type === "branch") {
            resolvePendingRpcResponse(s, {
              id: cmd.id,
              type: "response",
              command: "branch",
              success: true,
              data: { text: "Old prompt", cancelled: false },
            });
          } else if (cmd.type === "get_state") {
            resolvePendingRpcResponse(s, {
              id: cmd.id,
              type: "response",
              command: "get_state",
              success: true,
              data: { sessionId: "sess_new", sessionFile: "/tmp/sess_new.jsonl" },
            });
          }
        });
      },
    };

    const editedMessage = {
      id: "msg_2",
      author: { bot: false, id: "user_1" },
      channel: thread,
      content: "Prompt 2 Edited!",
      attachments: new Map(),
      react: async () => {},
    } as unknown as Message;

    const result = await handleMessageEditAsRewind(editedMessage, editedMessage, context);
    expect(result).toBe(true);

    // Verify session branched
    const branchCmd = sentRpcCommands.find((c) => c.type === "branch");
    expect(branchCmd).toBeDefined();
    expect(branchCmd?.entryId).toBe("e2");
    // Verify state was refreshed in memory and persistent store
    expect(session.sessionId).toBe("sess_new");
    expect(session.sessionFile).toBe("/tmp/sess_new.jsonl");
    const persistedBinding = await store.get(session.threadId);
    expect(persistedBinding?.sessionId).toBe("sess_new");
    expect(persistedBinding?.sessionFile).toBe("/tmp/sess_new.jsonl");

    // Verify new prompt was submitted
    const promptCmd = sentRpcCommands.find(
      (c) => c.type === "prompt" && c.message === "Prompt 2 Edited!",
    );
    expect(promptCmd).toBeDefined();

    // Verify checkpoints: msg_1 retained, msg_2 updated with new prompt
    expect(session.checkpoints?.length).toBe(2);
    expect(session.checkpoints?.[0].discordMessageId).toBe("msg_1");
    expect(session.checkpoints?.[1].discordMessageId).toBe("msg_2");
    expect(session.checkpoints?.[1].promptText).toBe("Prompt 2 Edited!");
  });

  it("rewinds to correct entryId even when branch messages contain intervening slash commands", async () => {
    const thread = createMockThread();
    recordUserTurnCheckpoint(session, "msg_1", "Prompt 1");
    recordUserTurnCheckpoint(session, "msg_2", "Prompt 2");

    const context: RewindContext = {
      sessionManager,
      isUserAllowed: () => true,
      extractMessagePrompt: async (_s, m) => ({ text: m.content, images: [] }),
      startTyping: () => {},
      sendRpc: (s, cmd) => {
        sentRpcCommands.push(cmd);
        queueMicrotask(() => {
          if (cmd.type === "get_branch_messages") {
            resolvePendingRpcResponse(s, {
              id: cmd.id,
              type: "response",
              command: "get_branch_messages",
              success: true,
              data: {
                messages: [
                  { entryId: "e1", text: "Prompt 1" },
                  { entryId: "slash_cmd_1", text: "/model gpt-5.5" },
                  { entryId: "slash_cmd_2", text: "/cmd git status" },
                  { entryId: "e2_actual", text: "Prompt 2" },
                ],
              },
            });
          } else if (cmd.type === "branch") {
            resolvePendingRpcResponse(s, {
              id: cmd.id,
              type: "response",
              command: "branch",
              success: true,
              data: { text: "Old prompt", cancelled: false },
            });
          } else if (cmd.type === "get_state") {
            resolvePendingRpcResponse(s, {
              id: cmd.id,
              type: "response",
              command: "get_state",
              success: true,
              data: { sessionId: "sess_new_2" },
            });
          }
        });
      },
    };

    const editedMessage = {
      id: "msg_2",
      author: { bot: false, id: "user_1" },
      channel: thread,
      content: "Prompt 2 Rewound!",
      attachments: new Map(),
      react: async () => {},
    } as unknown as Message;

    const result = await handleMessageEditAsRewind(editedMessage, editedMessage, context);
    expect(result).toBe(true);

    const branchCmd = sentRpcCommands.find((c) => c.type === "branch");
    expect(branchCmd).toBeDefined();
    // Must branch to e2_actual (matched by checkpoint), NOT slash_cmd_1 (index 1)
    expect(branchCmd?.entryId).toBe("e2_actual");
  });

  it("rewinds turn 1 and updates thread name", async () => {
    const thread = createMockThread();
    recordUserTurnCheckpoint(session, "msg_1", "Turn 1 Prompt");
    recordAssistantMessage(session, "bot_1");
    recordUserTurnCheckpoint(session, "msg_2", "Turn 2 Prompt");
    recordAssistantMessage(session, "bot_2");

    const context: RewindContext = {
      sessionManager,
      isUserAllowed: () => true,
      extractMessagePrompt: async (_s, m) => ({ text: m.content, images: [] }),
      startTyping: () => {},
      updateThreadNameFromPrompt: async (_t, name) => {
        threadNameUpdated = name;
      },
      sendRpc: (s, cmd) => {
        sentRpcCommands.push(cmd);
        queueMicrotask(() => {
          if (cmd.type === "get_branch_messages") {
            resolvePendingRpcResponse(s, {
              id: cmd.id,
              type: "response",
              command: "get_branch_messages",
              success: true,
              data: {
                messages: [
                  { entryId: "e1", text: "Turn 1 Prompt" },
                  { entryId: "e2", text: "Turn 2 Prompt" },
                ],
              },
            });
          } else if (cmd.type === "branch") {
            resolvePendingRpcResponse(s, {
              id: cmd.id,
              type: "response",
              command: "branch",
              success: true,
              data: { text: "Turn 1 Prompt", cancelled: false },
            });
          } else if (cmd.type === "get_state") {
            resolvePendingRpcResponse(s, {
              id: cmd.id,
              type: "response",
              command: "get_state",
              success: true,
              data: { sessionId: "sess_t1_branched" },
            });
          }
        });
      },
    };
    const editedMessage = {
      id: "msg_1",
      author: { bot: false, id: "user_1" },
      channel: thread,
      content: "Brand New Turn 1!",
      attachments: new Map(),
      react: async () => {},
    } as unknown as Message;

    const result = await handleMessageEditAsRewind(editedMessage, editedMessage, context);
    expect(result).toBe(true);

    // Thread name updated because turn 1 was rewound
    expect(threadNameUpdated).toBe("Brand New Turn 1!");

    // Checkpoints pruned to just turn 1
    expect(session.checkpoints?.length).toBe(1);
    expect(session.checkpoints?.[0].discordMessageId).toBe("msg_1");
    expect(session.checkpoints?.[0].promptText).toBe("Brand New Turn 1!");
  });
});
describe("Real OMP RPC Rewind Integration", () => {
  it("branches and rewinds multi-turn conversation in real omp process", async () => {
    const proc = Bun.spawn(["omp", "--mode", "rpc", "--no-session"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const session: SessionContext = {
        process: proc as unknown as SessionContext["process"],
        threadId: "real_omp_test",
        cwd: "/tmp",
        currentStreamBuffer: "",
        lastEditTimestamp: 0,
        pendingRpcRequests: new Map(),
      };

      const nodeStdout = proc.stdout;
      const reader = nodeStdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const readyPromise = Promise.withResolvers<void>();

      (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value);
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line) as Record<string, unknown>;
              if (msg.type === "ready") {
                readyPromise.resolve();
              } else if (msg.type === "response") {
                resolvePendingRpcResponse(session, msg);
              } else if (msg.type === "error" && typeof msg.id === "string") {
                rejectPendingRpcError(session, msg.id, String(msg.message));
              }
            } catch {}
          }
        }
      })();

      await readyPromise.promise;
      await sendRpcRequest(session, {
        type: "negotiate_protocol",
        protocolVersion: 2,
      });

      // Query initial branch messages
      const initial = await sendRpcRequest<{ messages: Array<{ entryId: string; text: string }> }>(
        session,
        { type: "get_branch_messages" },
      );
      expect(initial.messages).toEqual([]);

      // Submit prompt 1
      await sendRpcRequest(session, {
        type: "prompt",
        message: "/help",
      });

      // Wait for turn to settle and branch messages to reflect turn 1
      let branchMsgs: Array<{ entryId: string; text: string }> = [];
      for (let i = 0; i < 20; i++) {
        await Bun.sleep(100);
        const res = await sendRpcRequest<{ messages: Array<{ entryId: string; text: string }> }>(
          session,
          { type: "get_branch_messages" },
        );
        if (res.messages.length > 0) {
          branchMsgs = res.messages;
          break;
        }
      }

      expect(branchMsgs.length).toBeGreaterThan(0);
      const turn1EntryId = branchMsgs[0].entryId;
      expect(typeof turn1EntryId).toBe("string");

      // Branch to turn 1 entryId
      const branchResult = await sendRpcRequest<{ text: string; cancelled: boolean }>(
        session,
        { type: "branch", entryId: turn1EntryId },
      );
      expect(branchResult.cancelled).toBe(false);

      // Verify transcript was rewound
      const afterBranch = await sendRpcRequest<{ messages: Array<{ entryId: string; text: string }> }>(
        session,
        { type: "get_branch_messages" },
      );
      expect(afterBranch.messages.length).toBe(0);
    } finally {
      proc.kill();
    }
  });
});

