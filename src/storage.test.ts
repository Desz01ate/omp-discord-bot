import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createSessionStore,
  SqliteSessionStore,
  InMemorySessionStore,
  type SessionBinding,
  type SessionStore,
} from "./storage";

describe("SessionStore Implementations", () => {
  const testDir = join(tmpdir(), "omp-storage-test-" + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("SqliteSessionStore", () => {
    it("initializes and performs CRUD operations in memory (:memory:)", async () => {
      const store = new SqliteSessionStore({ dbPath: ":memory:" });
      await store.init();

      const binding1: SessionBinding = {
        threadId: "thread_1",
        cwd: "/workspace/proj1",
        initialModel: "claude-3-7-sonnet",
        createdAt: 1000,
        updatedAt: 1000,
        metadata: { user: "alice", role: "admin" },
      };

      await store.set(binding1);

      const retrieved = await store.get("thread_1");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.threadId).toBe("thread_1");
      expect(retrieved?.cwd).toBe("/workspace/proj1");
      expect(retrieved?.initialModel).toBe("claude-3-7-sonnet");
      expect(retrieved?.createdAt).toBe(1000);
      expect(retrieved?.metadata).toEqual({ user: "alice", role: "admin" });

      // Upsert update
      const updatedBinding: SessionBinding = {
        threadId: "thread_1",
        cwd: "/workspace/proj1-updated",
        initialModel: "gpt-5.2",
        createdAt: 1000,
        updatedAt: 2000,
        metadata: { user: "alice", role: "superadmin" },
      };
      await store.set(updatedBinding);

      const retrievedUpdated = await store.get("thread_1");
      expect(retrievedUpdated?.cwd).toBe("/workspace/proj1-updated");
      expect(retrievedUpdated?.initialModel).toBe("gpt-5.2");
      expect(retrievedUpdated?.updatedAt).toBe(2000);
      expect(retrievedUpdated?.metadata).toEqual({ user: "alice", role: "superadmin" });

      // Add another binding
      await store.set({
        threadId: "thread_2",
        cwd: "/workspace/proj2",
        createdAt: 3000,
        updatedAt: 3000,
      });

      const list = await store.list();
      expect(list.length).toBe(2);
      expect(list[0].threadId).toBe("thread_1");
      expect(list[1].threadId).toBe("thread_2");
      expect(list[1].initialModel).toBeUndefined();

      // Delete thread_1
      const deleteResult = await store.delete("thread_1");
      expect(deleteResult).toBe(true);

      const retrievedAfterDelete = await store.get("thread_1");
      expect(retrievedAfterDelete).toBeNull();

      const deleteNonExistent = await store.delete("non_existent");
      expect(deleteNonExistent).toBe(false);

      // Clear remaining
      await store.clear();
      const listAfterClear = await store.list();
      expect(listAfterClear.length).toBe(0);

      await store.close();
    });

    it("persists sessions across store restarts using SQLite file on disk", async () => {
      const dbPath = join(testDir, "test-sessions.sqlite");

      // Instance 1: write session
      const store1 = new SqliteSessionStore({ dbPath });
      await store1.init();

      await store1.set({
        threadId: "persistent_thread_100",
        cwd: "/home/user/project",
        initialModel: "o3-mini",
        createdAt: 5000,
        updatedAt: 5000,
        metadata: { tags: ["prod", "agent"] },
      });

      await store1.close();

      // Instance 2: reopen same file and verify content
      const store2 = new SqliteSessionStore({ dbPath });
      await store2.init();

      const retrieved = await store2.get("persistent_thread_100");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.threadId).toBe("persistent_thread_100");
      expect(retrieved?.cwd).toBe("/home/user/project");
      expect(retrieved?.initialModel).toBe("o3-mini");
      expect(retrieved?.metadata).toEqual({ tags: ["prod", "agent"] });

      const allSessions = await store2.list();
      expect(allSessions.length).toBe(1);

      await store2.close();
    });

    it("throws when operating on uninitialized store", async () => {
      const store = new SqliteSessionStore({ dbPath: ":memory:" });
      expect(store.get("t1")).rejects.toThrow("not initialized");
      expect(store.set({ threadId: "t1", cwd: "/test", createdAt: 1, updatedAt: 1 })).rejects.toThrow("not initialized");
      expect(store.list()).rejects.toThrow("not initialized");
      expect(store.delete("t1")).rejects.toThrow("not initialized");
      expect(store.clear()).rejects.toThrow("not initialized");
    });
  });

  describe("InMemorySessionStore", () => {
    it("implements SessionStore interface and performs CRUD", async () => {
      const store = new InMemorySessionStore();
      await store.init();

      await store.set({
        threadId: "mem_1",
        cwd: "/tmp/mem1",
        createdAt: 100,
        updatedAt: 100,
      });

      const item = await store.get("mem_1");
      expect(item?.threadId).toBe("mem_1");
      expect(item?.cwd).toBe("/tmp/mem1");

      const list = await store.list();
      expect(list.length).toBe(1);

      const deleted = await store.delete("mem_1");
      expect(deleted).toBe(true);

      const emptyList = await store.list();
      expect(emptyList.length).toBe(0);

      await store.close();
    });

    it("throws when operating on uninitialized memory store", async () => {
      const store = new InMemorySessionStore();
      expect(store.get("t1")).rejects.toThrow("not initialized");
    });
  });

  describe("createSessionStore factory", () => {
    it("creates an InMemorySessionStore when type is 'memory'", async () => {
      const store = createSessionStore({ type: "memory" });
      expect(store).toBeInstanceOf(InMemorySessionStore);
      await store.init();
      await store.close?.();
    });

    it("creates a SqliteSessionStore by default", async () => {
      const dbPath = join(testDir, "factory-default.sqlite");
      const store = createSessionStore({ dbPath });
      expect(store).toBeInstanceOf(SqliteSessionStore);
      await store.init();
      await store.close?.();
    });
  });
});
