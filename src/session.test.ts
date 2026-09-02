import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface MockProcess {
  killed: boolean;
  kill: () => void;
}

interface MockSession {
  process: MockProcess;
  threadId: string;
  cwd: string;
  editTimer?: Timer;
  typingTimer?: Timer;
}

interface MockThread {
  id: string;
  name: string;
  deleted: boolean;
  isThread: () => boolean;
  delete: (reason?: string) => Promise<MockThread>;
}

describe("Session Termination (/omp-terminate-all)", () => {
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
      name: `thread-${threadId}`,
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
  }

  it("terminates a single session: kills process, cleans up attachments, deletes thread, and removes from map", async () => {
    const sessionsMap = new Map<string, MockSession>();
    const threadsMap = new Map<string, MockThread>();

    const { session, thread } = createMockSession("t1");
    sessionsMap.set("t1", session);
    threadsMap.set("t1", thread);

    // Create attachment dir for session
    const attDir = join(testDir, ".discord-attachments", "t1");
    mkdirSync(attDir, { recursive: true });
    writeFileSync(join(attDir, "file.txt"), "attachment content");

    expect(existsSync(attDir)).toBe(true);
    expect(sessionsMap.size).toBe(1);
    expect(session.process.killed).toBe(false);
    expect(thread.deleted).toBe(false);

    await terminateMockSession(session, threadsMap, sessionsMap, true);

    expect(session.process.killed).toBe(true);
    expect(thread.deleted).toBe(true);
    expect(existsSync(attDir)).toBe(false);
    expect(sessionsMap.size).toBe(0);
    expect(session.editTimer).toBeUndefined();
    expect(session.typingTimer).toBeUndefined();
  });

  it("terminates all active sessions concurrently", async () => {
    const sessionsMap = new Map<string, MockSession>();
    const threadsMap = new Map<string, MockThread>();

    for (let i = 1; i <= 5; i++) {
      const id = `thread_${i}`;
      const { session, thread } = createMockSession(id);
      sessionsMap.set(id, session);
      threadsMap.set(id, thread);

      const attDir = join(testDir, ".discord-attachments", id);
      mkdirSync(attDir, { recursive: true });
      writeFileSync(join(attDir, "data.bin"), "payload");
    }

    expect(sessionsMap.size).toBe(5);

    const active = Array.from(sessionsMap.values());
    await Promise.allSettled(active.map((s) => terminateMockSession(s, threadsMap, sessionsMap, true)));

    expect(sessionsMap.size).toBe(0);
    for (const s of active) {
      expect(s.process.killed).toBe(true);
      const thread = threadsMap.get(s.threadId);
      expect(thread?.deleted).toBe(true);
      const attDir = join(testDir, ".discord-attachments", s.threadId);
      expect(existsSync(attDir)).toBe(false);
    }
  });

  it("handles empty sessions gracefully", async () => {
    const sessionsMap = new Map<string, MockSession>();
    const active = Array.from(sessionsMap.values());
    expect(active.length).toBe(0);
  });
});
