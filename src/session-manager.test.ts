import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Client, ThreadChannel } from "discord.js";
import {
  SessionManager,
  cleanOmpSessionFiles,
  resolveOmpSessionPath,
  type SessionContext,
  type OmpProcess,
} from "./session-manager";
import { SqliteSessionStore } from "./storage";
import { createGitWorktree } from "./workspace";

interface MockThread {
  id: string;
  name: string;
  deleted: boolean;
  archived?: boolean;
  locked?: boolean;
  isThread: () => boolean;
  delete: (reason?: string) => Promise<MockThread>;
}

describe("SessionManager Composite Service", () => {
  const testDir = join(tmpdir(), "omp-session-mgr-test-" + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createMockSessionContext(threadId: string, customCwd = testDir): {
    session: SessionContext;
    processKilled: { value: boolean };
  } {
    const processKilled = { value: false };
    const fakeProcess = {
      killed: false,
      kill: () => {
        processKilled.value = true;
      },
    } as unknown as OmpProcess;

    let fakeTimerActive = true;
    const fakeTimer = {
      unref: () => fakeTimer,
      ref: () => fakeTimer,
      hasRef: () => fakeTimerActive,
      refresh: () => fakeTimer,
      [Symbol.dispose]: () => {},
    } as unknown as Timer;

    const session: SessionContext = {
      process: fakeProcess,
      threadId,
      cwd: customCwd,
      currentStreamBuffer: "",
      lastEditTimestamp: 0,
      editTimer: fakeTimer,
      typingTimer: fakeTimer,
    };

    return { session, processKilled };
  }

  function createMockThread(id: string, name = `thread-${ id }`): MockThread {
    const thread: MockThread = {
      id,
      name,
      deleted: false,
      isThread: () => true,
      delete: async () => {
        thread.deleted = true;
        return thread;
      },
    };
    return thread;
  }

  it("initializes, registers active sessions and persists them to underlying store", async () => {
    const store = new SqliteSessionStore({ dbPath: ":memory:" });
    const manager = new SessionManager({ store });
    await manager.init();

    expect(manager.count).toBe(0);

    const { session } = createMockSessionContext("t1");
    await manager.register(session, {
      initialModel: "claude-3-7-sonnet",
      metadata: { author: "alice" },
    });

    expect(manager.count).toBe(1);
    expect(manager.has("t1")).toBe(true);
    expect(manager.get("t1")).toBe(session);

    const activeList = manager.getActiveSessions();
    expect(activeList.length).toBe(1);
    expect(activeList[0].threadId).toBe("t1");

    // Check cold store
    const persisted = await store.get("t1");
    expect(persisted).not.toBeNull();
    expect(persisted?.threadId).toBe("t1");
    expect(persisted?.initialModel).toBe("claude-3-7-sonnet");
    expect(persisted?.metadata).toEqual({ author: "alice" });

    await manager.close();
  });

  it("terminates a single session: cleans timers, kills process, cleans attachments, removes from map and store", async () => {
    const store = new SqliteSessionStore({ dbPath: ":memory:" });
    const manager = new SessionManager({ store });
    await manager.init();

    const { session, processKilled } = createMockSessionContext("t_term");
    await manager.register(session);

    // Create attachment file
    const attDir = join(testDir, ".discord-attachments", "t_term");
    mkdirSync(attDir, { recursive: true });
    writeFileSync(join(attDir, "photo.jpg"), "fake photo");
    expect(existsSync(attDir)).toBe(true);

    const mockThread = createMockThread("t_term");
    const mockClient = {
      channels: {
        cache: new Map<string, unknown>([["t_term", mockThread]]),
        fetch: async (id: string) => (id === "t_term" ? mockThread : null),
      },
    } as unknown as Client;

    await manager.terminate(session, mockClient, true);

    expect(processKilled.value).toBe(true);
    expect(mockThread.deleted).toBe(true);
    expect(existsSync(attDir)).toBe(false);
    expect(session.editTimer).toBeUndefined();
    expect(session.typingTimer).toBeUndefined();
    expect(manager.has("t_term")).toBe(false);
    expect(await store.get("t_term")).toBeNull();

    await manager.close();
  });

  it("terminates all active sessions concurrently", async () => {
    const store = new SqliteSessionStore({ dbPath: ":memory:" });
    const manager = new SessionManager({ store });
    await manager.init();

    const mockThreads = new Map<string, MockThread>();
    for (let i = 1; i <= 4; i++) {
      const id = `thread_${ i }`;
      const { session } = createMockSessionContext(id);
      await manager.register(session);
      mockThreads.set(id, createMockThread(id));
    }

    expect(manager.count).toBe(4);

    const mockClient = {
      channels: {
        cache: mockThreads,
        fetch: async (id: string) => mockThreads.get(id) || null,
      },
    } as unknown as Client;

    const count = await manager.terminateAll(mockClient, true);
    expect(count).toBe(4);
    expect(manager.count).toBe(0);
    expect((await store.list()).length).toBe(0);

    for (const [, thread] of mockThreads) {
      expect(thread.deleted).toBe(true);
    }

    await manager.close();
  });

  it("restores active sessions from persistent store and prunes dead ones", async () => {
    const store = new SqliteSessionStore({ dbPath: ":memory:" });
    await store.init();

    const proj1 = join(testDir, "proj1");
    const proj2 = join(testDir, "proj2");
    mkdirSync(proj1, { recursive: true });
    mkdirSync(proj2, { recursive: true });

    // Stored bindings:
    // 1. live_thread (valid dir, valid thread)
    // 2. deleted_thread (valid dir, missing from discord)
    // 3. dead_dir_thread (missing dir)
    await store.set({
      threadId: "live_thread",
      cwd: proj1,
      initialModel: "gpt-5.2",
      createdAt: 1000,
      updatedAt: 1000,
    });
    await store.set({
      threadId: "deleted_thread",
      cwd: proj2,
      createdAt: 2000,
      updatedAt: 2000,
    });
    await store.set({
      threadId: "dead_dir_thread",
      cwd: join(testDir, "non-existent-dir"),
      createdAt: 3000,
      updatedAt: 3000,
    });

    const manager = new SessionManager({ store });
    await manager.init();

    const liveThread = createMockThread("live_thread");
    const mockClient = {
      channels: {
        cache: new Map<string, unknown>([["live_thread", liveThread]]),
        fetch: async (id: string) => (id === "live_thread" ? liveThread : null),
      },
    } as unknown as Client;

    const spawnCalls: Array<{ threadId: string; cwd: string; model?: string; sessionId?: string; sessionFile?: string }> = [];
    const spawnSession = (
      thread: ThreadChannel,
      cwd: string,
      initialModel?: string,
      metadata?: Record<string, unknown>,
      sessionId?: string,
      sessionFile?: string,
    ): SessionContext => {
      spawnCalls.push({ threadId: thread.id, cwd, model: initialModel, sessionId, sessionFile });
      const { session } = createMockSessionContext(thread.id, cwd);
      return session;
    };

    const restoredCount = await manager.restoreAll(mockClient, spawnSession);
    expect(restoredCount).toBe(1);
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].threadId).toBe("live_thread");
    expect(spawnCalls[0].cwd).toBe(proj1);
    expect(spawnCalls[0].model).toBe("gpt-5.2");

    expect(manager.count).toBe(1);
    expect(manager.has("live_thread")).toBe(true);

    // Verify deleted_thread and dead_dir_thread were cleaned up from the persistent store
    const remainingStore = await store.list();
    expect(remainingStore.length).toBe(1);
    expect(remainingStore[0].threadId).toBe("live_thread");

    await manager.close();
  });

  it("cleans up orphaned worktree when restored thread is inaccessible", async () => {
    const store = new SqliteSessionStore({ dbPath: ":memory:" });
    await store.init();

    const repoRoot = join(testDir, "worktree-repo");
    mkdirSync(repoRoot, { recursive: true });
    const gitProc = Bun.spawnSync(["git", "init", "-q"], { cwd: repoRoot });
    expect(gitProc.exitCode).toBe(0);
    writeFileSync(join(repoRoot, "init.txt"), "init\n");
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: repoRoot });
    Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: repoRoot });
    Bun.spawnSync(["git", "add", "init.txt"], { cwd: repoRoot });
    Bun.spawnSync(["git", "commit", "-qm", "init"], { cwd: repoRoot });

    const worktreeResult = await createGitWorktree(repoRoot, "orphaned_thread");
    expect(worktreeResult.ok).toBe(true);
    const worktree = worktreeResult.worktree!;
    const worktreePath = worktree.path;

    await store.set({
      threadId: "orphaned_thread",
      cwd: worktreePath,
      createdAt: 1000,
      updatedAt: 1000,
      metadata: { worktree },
    });

    const manager = new SessionManager({ store });
    await manager.init();

    const mockClient = {
      channels: {
        cache: new Map<string, unknown>(),
        fetch: async () => null,
      },
    } as unknown as Client;

    const restoredCount = await manager.restoreAll(mockClient, () => {
      throw new Error("Should not spawn");
    });

    expect(restoredCount).toBe(0);
    expect(existsSync(worktreePath)).toBe(false);
    expect(await store.get("orphaned_thread")).toBeNull();

    await manager.close();
  });

  it("resolves OMP session paths and cleans up session files and companion directories", () => {
    const ompSessionFile = join(testDir, "test_session_123.jsonl");
    const companionDir = join(testDir, "test_session_123");
    writeFileSync(ompSessionFile, '{ "type":"session","id":"uuid-123" }\n');
    mkdirSync(companionDir, { recursive: true });
    writeFileSync(join(companionDir, "log.txt"), "log data");

    expect(existsSync(ompSessionFile)).toBe(true);
    expect(existsSync(companionDir)).toBe(true);

    const resolved = resolveOmpSessionPath(ompSessionFile, "uuid-123");
    expect(resolved).toBe(ompSessionFile);

    cleanOmpSessionFiles(ompSessionFile, "uuid-123");
    expect(existsSync(ompSessionFile)).toBe(false);
    expect(existsSync(companionDir)).toBe(false);
  });

  it("updates active session and persistent store bindings with sessionId and sessionFile", async () => {
    const store = new SqliteSessionStore({ dbPath: ":memory:" });
    const manager = new SessionManager({ store });
    await manager.init();

    const { session } = createMockSessionContext("t_update");
    await manager.register(session);

    expect(session.sessionId).toBeUndefined();
    expect(session.sessionFile).toBeUndefined();

    await manager.update("t_update", {
      sessionId: "omp-uuid-456",
      sessionFile: "/path/to/omp-456.jsonl",
    });

    expect(session.sessionId).toBe("omp-uuid-456");
    expect(session.sessionFile).toBe("/path/to/omp-456.jsonl");

    const stored = await store.get("t_update");
    expect(stored?.sessionId).toBe("omp-uuid-456");
    expect(stored?.sessionFile).toBe("/path/to/omp-456.jsonl");

    await manager.close();
  });

  it("terminates a session and cleans up its OMP session files on disk", async () => {
    const store = new SqliteSessionStore({ dbPath: ":memory:" });
    const manager = new SessionManager({ store });
    await manager.init();

    const sessionFile = join(testDir, "to_terminate.jsonl");
    writeFileSync(sessionFile, '{ "type":"session","id":"to_terminate_uuid" }\n');

    const { session } = createMockSessionContext("t_term_omp");
    session.sessionFile = sessionFile;
    session.sessionId = "to_terminate_uuid";
    await manager.register(session);

    expect(existsSync(sessionFile)).toBe(true);

    await manager.terminate(session, undefined, false);

    expect(existsSync(sessionFile)).toBe(false);
    expect(manager.has("t_term_omp")).toBe(false);
    expect(await store.get("t_term_omp")).toBeNull();

    await manager.close();
  });

  it("restores active sessions with sessionId and sessionFile and passes them to spawnSession", async () => {
    const store = new SqliteSessionStore({ dbPath: ":memory:" });
    await store.init();

    const proj = join(testDir, "proj_restore");
    mkdirSync(proj, { recursive: true });
    const sessFile = join(testDir, "restored.jsonl");
    writeFileSync(sessFile, '{ "type":"session" }\n');

    await store.set({
      threadId: "t_resume_thread",
      cwd: proj,
      initialModel: "claude-3-7-sonnet",
      sessionId: "saved-sess-uuid",
      sessionFile: sessFile,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const manager = new SessionManager({ store });
    await manager.init();

    const thread = createMockThread("t_resume_thread");
    const mockClient = {
      channels: {
        cache: new Map<string, unknown>([["t_resume_thread", thread]]),
        fetch: async () => thread,
      },
    } as unknown as Client;

    let receivedSessionId: string | undefined;
    let receivedSessionFile: string | undefined;

    await manager.restoreAll(
      mockClient,
      (t, cwd, model, metadata, sId, sFile) => {
        receivedSessionId = sId;
        receivedSessionFile = sFile;
        const { session } = createMockSessionContext(t.id, cwd);
        return session;
      },
    );

    expect(receivedSessionId).toBe("saved-sess-uuid");
    expect(receivedSessionFile).toBe(sessFile);

    const restoredSession = manager.get("t_resume_thread");
    expect(restoredSession?.sessionId).toBe("saved-sess-uuid");
    expect(restoredSession?.sessionFile).toBe(sessFile);

    await manager.close();
  });

  it("deactivates an active session in-memory while preserving persistent store binding and files", async () => {
    const store = new SqliteSessionStore({ dbPath: ":memory:" });
    const manager = new SessionManager({ store });
    await manager.init();

    const { session, processKilled } = createMockSessionContext("t_deact");
    const sessFile = join(testDir, "deact_session.jsonl");
    writeFileSync(sessFile, '{ "type":"session","id":"deact_uuid" }\n');
    session.sessionFile = sessFile;
    session.sessionId = "deact_uuid";

    // Create attachment file
    const attDir = join(testDir, ".discord-attachments", "t_deact");
    mkdirSync(attDir, { recursive: true });
    const photoPath = join(attDir, "photo.jpg");
    writeFileSync(photoPath, "fake photo");

    // Setup pending RPC request and timer
    let rpcRejected = false;
    let rpcError: Error | undefined;
    session.pendingRpcRequests = new Map([
      [
        "req_1",
        {
          command: "test_cmd",
          timer: { hasRef: () => false } as unknown as Timer,
          resolve: () => {},
          reject: (err: unknown) => {
            rpcRejected = true;
            rpcError = err instanceof Error ? err : new Error(String(err));
          },
        },
      ],
    ]);

    await manager.register(session);
    expect(manager.has("t_deact")).toBe(true);
    expect(await manager.hasBinding("t_deact")).toBe(true);

    manager.deactivate(session);

    // In-memory session should be deactivated
    expect(manager.has("t_deact")).toBe(false);
    expect(session.editTimer).toBeUndefined();
    expect(processKilled.value).toBe(true);
    expect(rpcRejected).toBe(true);
    expect(rpcError?.message).toBe("Session deactivated");

    // Persistent store binding and disk files must remain intact
    const binding = await manager.getBinding("t_deact");
    expect(binding).not.toBeNull();
    expect(binding?.threadId).toBe("t_deact");
    expect(binding?.sessionId).toBe("deact_uuid");
    expect(binding?.sessionFile).toBe(sessFile);
    expect(existsSync(sessFile)).toBe(true);
    expect(existsSync(photoPath)).toBe(true);

    await manager.close();
  });

  it("registers active session in-memory only via registerActive without overwriting store", async () => {
    const store = new SqliteSessionStore({ dbPath: ":memory:" });
    const manager = new SessionManager({ store });
    await manager.init();

    const { session } = createMockSessionContext("t_reg_active");
    await manager.register(session);
    const originalBinding = await manager.getBinding("t_reg_active");
    expect(originalBinding).not.toBeNull();

    manager.deactivate(session);
    expect(manager.has("t_reg_active")).toBe(false);

    const { session: resurrected } = createMockSessionContext("t_reg_active");
    manager.registerActive(resurrected);

    expect(manager.has("t_reg_active")).toBe(true);
    const bindingAfter = await manager.getBinding("t_reg_active");
    expect(bindingAfter?.createdAt).toBe(originalBinding?.createdAt);

    await manager.close();
  });
});
