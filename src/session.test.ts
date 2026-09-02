import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SqliteSessionStore, type SessionBinding } from "./storage";

interface MockProcess {
  killed: boolean;
  kill: () => void;
}

interface MockSession {
  process: MockProcess;
  threadId: string;
  cwd: string;
  sessionId?: string;
  sessionFile?: string;
  editTimer?: Timer;
  typingTimer?: Timer;
}

interface MockThread {
  id: string;
  name: string;
  deleted: boolean;
  archived?: boolean;
  locked?: boolean;
  isThread: () => boolean;
  delete: (reason?: string) => Promise<MockThread>;
}

describe("Session Termination and Persistence", () => {
  const testDir = join(tmpdir(), "omp-session-test-" + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createMockSession(threadId: string): { session: MockSession; thread: MockThread } {
    const thread: MockThread = {
      id: threadId,
      name: `thread-${ threadId }`,
      deleted: false,
      isThread: () => true,
      delete: async () => {
        thread.deleted = true;
        return thread;
      },
    };

    const sessionProcess: MockProcess = {
      killed: false,
      kill: () => {
        sessionProcess.killed = true;
      },
    };

    let fakeTimerActive = true;
    const fakeTimer = {
      unref: () => fakeTimer,
      ref: () => fakeTimer,
      hasRef: () => fakeTimerActive,
      refresh: () => fakeTimer,
      [Symbol.dispose]: () => {},
    } as unknown as Timer;

    const session: MockSession = {
      process: sessionProcess,
      threadId,
      cwd: testDir,
      editTimer: fakeTimer,
      typingTimer: fakeTimer,
    };

    return { session, thread };
  }

  function cleanAttachments(session: MockSession) {
    const primaryThreadDir = join(session.cwd, ".discord-attachments", session.threadId);
    if (existsSync(primaryThreadDir)) {
      rmSync(primaryThreadDir, { recursive: true, force: true });
    }
  }

  async function terminateMockSession(
    session: MockSession,
    threadsMap: Map<string, MockThread>,
    sessionsMap: Map<string, MockSession>,
    store?: SqliteSessionStore,
    deleteThread = true,
  ) {
    if (session.editTimer) {
      clearTimeout(session.editTimer);
      session.editTimer = undefined;
    }
    if (session.typingTimer) {
      clearInterval(session.typingTimer);
      session.typingTimer = undefined;
    }

    try {
      session.process.kill();
    } catch {}

    try {
      cleanAttachments(session);
    } catch {}

    if (deleteThread) {
      const thread = threadsMap.get(session.threadId);
      if (thread && thread.isThread()) {
        await thread.delete("Terminated via /omp-terminate-all");
      }
    }

    sessionsMap.delete(session.threadId);
    if (store) {
      await store.delete(session.threadId);
    }
  }

  it("terminates a single session: kills process, cleans up attachments, deletes thread, and removes from map and store", async () => {
    const store = new SqliteSessionStore({ dbPath: ":memory:" });
    await store.init();

    const sessionsMap = new Map<string, MockSession>();
    const threadsMap = new Map<string, MockThread>();

    const { session, thread } = createMockSession("t1");
    sessionsMap.set("t1", session);
    threadsMap.set("t1", thread);
    await store.set({
      threadId: "t1",
      cwd: testDir,
      initialModel: "claude-3-7-sonnet",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Create attachment dir for session
    const attDir = join(testDir, ".discord-attachments", "t1");
    mkdirSync(attDir, { recursive: true });
    writeFileSync(join(attDir, "file.txt"), "attachment content");

    expect(existsSync(attDir)).toBe(true);
    expect(sessionsMap.size).toBe(1);
    expect(session.process.killed).toBe(false);
    expect(thread.deleted).toBe(false);
    expect(await store.get("t1")).not.toBeNull();

    await terminateMockSession(session, threadsMap, sessionsMap, store, true);

    expect(session.process.killed).toBe(true);
    expect(thread.deleted).toBe(true);
    expect(existsSync(attDir)).toBe(false);
    expect(sessionsMap.size).toBe(0);
    expect(session.editTimer).toBeUndefined();
    expect(session.typingTimer).toBeUndefined();
    expect(await store.get("t1")).toBeNull();

    await store.close();
  });

  it("terminates all active sessions concurrently and clears store bindings", async () => {
    const store = new SqliteSessionStore({ dbPath: ":memory:" });
    await store.init();

    const sessionsMap = new Map<string, MockSession>();
    const threadsMap = new Map<string, MockThread>();

    for (let i = 1; i <= 5; i++) {
      const id = `thread_${ i }`;
      const { session, thread } = createMockSession(id);
      sessionsMap.set(id, session);
      threadsMap.set(id, thread);
      await store.set({
        threadId: id,
        cwd: testDir,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const attDir = join(testDir, ".discord-attachments", id);
      mkdirSync(attDir, { recursive: true });
      writeFileSync(join(attDir, "data.bin"), "payload");
    }

    expect(sessionsMap.size).toBe(5);
    expect((await store.list()).length).toBe(5);

    const active = Array.from(sessionsMap.values());
    await Promise.allSettled(active.map((s) => terminateMockSession(s, threadsMap, sessionsMap, store, true)));

    expect(sessionsMap.size).toBe(0);
    expect((await store.list()).length).toBe(0);

    for (const s of active) {
      expect(s.process.killed).toBe(true);
      const thread = threadsMap.get(s.threadId);
      expect(thread?.deleted).toBe(true);
      const attDir = join(testDir, ".discord-attachments", s.threadId);
      expect(existsSync(attDir)).toBe(false);
    }

    await store.close();
  });

  it("simulates bot restart restoration from SQLite store", async () => {
    const dbPath = join(testDir, "restart-test.sqlite");

    // Phase 1: Store sessions prior to crash / restart
    const store1 = new SqliteSessionStore({ dbPath });
    await store1.init();

    const projectDir1 = join(testDir, "proj1");
    const projectDir2 = join(testDir, "proj2");
    mkdirSync(projectDir1, { recursive: true });
    mkdirSync(projectDir2, { recursive: true });

    await store1.set({
      threadId: "live_thread_1",
      cwd: projectDir1,
      initialModel: "gpt-5.2",
      sessionId: "session-uuid-1",
      sessionFile: "/root/.omp/agent/sessions/sess1.jsonl",
      createdAt: 1000,
      updatedAt: 1000,
    });

    await store1.set({
      threadId: "deleted_thread_2",
      cwd: projectDir2,
      createdAt: 2000,
      updatedAt: 2000,
    });

    await store1.close();

    // Phase 2: Bot boots up, opens store and restores active threads
    const store2 = new SqliteSessionStore({ dbPath });
    await store2.init();

    const bindings = await store2.list();
    expect(bindings.length).toBe(2);

    // Mock discord client fetch
    const mockDiscordThreads = new Map<string, MockThread>([
      [
        "live_thread_1",
        (() => {
          const mock: MockThread = {
            id: "live_thread_1",
            name: "proj1 (abc123)",
            deleted: false,
            isThread: () => true,
            delete: async () => {
              mock.deleted = true;
              return mock;
            },
          };
          return mock;
        })(),
      ],
    ]);

    const restoredSessions = new Map<string, MockSession>();

    for (const binding of bindings) {
      if (!existsSync(binding.cwd)) {
        await store2.delete(binding.threadId);
        continue;
      }
      const thread = mockDiscordThreads.get(binding.threadId);
      if (!thread || !thread.isThread()) {
        // Thread deleted while offline
        await store2.delete(binding.threadId);
        continue;
      }
      const { session } = createMockSession(binding.threadId);
      session.cwd = binding.cwd;
      session.sessionId = binding.sessionId;
      session.sessionFile = binding.sessionFile;
      restoredSessions.set(binding.threadId, session);
    }
    expect(restoredSessions.size).toBe(1);
    expect(restoredSessions.has("live_thread_1")).toBe(true);
    expect(restoredSessions.get("live_thread_1")?.cwd).toBe(projectDir1);
    expect(restoredSessions.get("live_thread_1")?.sessionId).toBe("session-uuid-1");
    expect(restoredSessions.get("live_thread_1")?.sessionFile).toBe("/root/.omp/agent/sessions/sess1.jsonl");
    const updatedBindings = await store2.list();
    expect(updatedBindings.length).toBe(1);
    expect(updatedBindings[0].threadId).toBe("live_thread_1");

    await store2.close();
  });

  it("handles empty sessions gracefully", async () => {
    const sessionsMap = new Map<string, MockSession>();
    const active = Array.from(sessionsMap.values());
    expect(active.length).toBe(0);
  });
});
