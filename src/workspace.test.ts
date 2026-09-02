import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "bun";
import {
  createGitWorktree,
  commitWorkspaceChanges,
  formatDiffForDiscord,
  inspectGitDiff,
  isInsideWorkspace,
  removeGitWorktree,
  resolveWorkspaceFile,
} from "./workspace";
import { SessionManager, type OmpProcess } from "./session-manager";
import { InMemorySessionStore } from "./storage";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(["git", "-c", "user.name=Discord Test", "-c", "user.email=discord@example.invalid", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

describe("workspace and Git integrations", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omp-workspace-test-"));
    git(root, "init", "-q");
    writeFileSync(join(root, "README.txt"), "initial\n");
    git(root, "add", "README.txt");
    git(root, "config", "user.name", "Discord Test");
    git(root, "config", "user.email", "discord@example.invalid");
    git(root, "commit", "-qm", "initial");
  });

  afterEach(() => {
    if (root && existsSync(root)) {rmSync(root, { recursive: true, force: true });}
  });

  it("inspects unstaged and staged diffs with path filters", async () => {
    writeFileSync(join(root, "README.txt"), "unstaged change\n");
    writeFileSync(join(root, "other.txt"), "other\n");

    const unstaged = await inspectGitDiff(root, { path: "README.txt" });
    expect(unstaged.isRepo).toBe(true);
    expect(unstaged.hasChanges).toBe(true);
    expect(unstaged.hasDiff).toBe(true);
    expect(unstaged.diff).toContain("unstaged change");
    expect(unstaged.diff).not.toContain("other");

    git(root, "add", "README.txt");
    const staged = await inspectGitDiff(root, { staged: true, path: "README.txt" });
    expect(staged.hasDiff).toBe(true);
    expect(staged.diff).toContain("unstaged change");

    const clean = await inspectGitDiff(root, { path: "missing.txt" });
    expect(clean.hasChanges).toBe(false);
    expect(clean.hasDiff).toBe(false);
  });

  it("formats short diffs inline and long diffs as patch attachments", () => {
    const inline = formatDiffForDiscord("@@ -1 +1 @@\n-old\n+new");
    expect(inline.inline).toBe(true);
    expect(inline.content).toContain("```diff");

    const long = formatDiffForDiscord("+".repeat(1901));
    expect(long.inline).toBe(false);
    expect(long.filename).toBe("git-diff.diff");
    expect(long.attachment?.byteLength).toBe(1901);
  });

  it("creates and removes an isolated worktree", async () => {
    const result = await createGitWorktree(root, "thread-test");
    expect(result.ok).toBe(true);
    expect(result.worktree?.branch).toBe("discord/thread-test");
    expect(result.worktree && existsSync(result.worktree.path)).toBe(true);

    const worktree = result.worktree!;
    writeFileSync(join(worktree.path, "isolated.txt"), "only in worktree\n");
    expect(existsSync(join(root, "isolated.txt"))).toBe(false);
    expect(await removeGitWorktree(worktree)).toBe(true);
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("commits staged changes or tracked changes and leaves untracked files alone", async () => {
    writeFileSync(join(root, "README.txt"), "tracked update\n");
    writeFileSync(join(root, "untracked.txt"), "not staged by -u\n");
    const result = await commitWorkspaceChanges(root, "update tracked file");
    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.hash).toBeTruthy();
    expect(git(root, "log", "-1", "--pretty=%s")).toBe("update tracked file");
    expect(existsSync(join(root, "untracked.txt"))).toBe(true);

    const noChanges = await commitWorkspaceChanges(root, "nothing left");
    expect(noChanges.ok).toBe(true);
    expect(noChanges.committed).toBe(false);
  });

  it("rejects workspace escapes and symlinks outside the session cwd", () => {
    const outside = mkdtempSync(join(tmpdir(), "omp-outside-test-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "secret");
      expect(isInsideWorkspace(join(root, "../outside"), root)).toBe(false);
      expect(resolveWorkspaceFile(root, "../outside/secret.txt").ok).toBe(false);
      const link = join(root, "secret-link.txt");
      symlinkSync(join(outside, "secret.txt"), link);
      expect(resolveWorkspaceFile(root, "secret-link.txt").ok).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it("cleans the temporary worktree when a session terminates", async () => {
    const worktreeResult = await createGitWorktree(root, "manager-thread");
    expect(worktreeResult.ok).toBe(true);
    const worktree = worktreeResult.worktree!;
    const store = new InMemorySessionStore();
    const manager = new SessionManager({ store });
    await manager.init();
    const session = {
      process: { kill() {} } as unknown as OmpProcess,
      threadId: "manager-thread",
      cwd: worktree.path,
      worktree,
      currentStreamBuffer: "",
      lastEditTimestamp: 0,
    };
    await manager.register(session);
    await manager.terminate(session, undefined, false);
    expect(existsSync(worktree.path)).toBe(false);
    expect(await store.get("manager-thread")).toBeNull();
    await manager.close();
  });
});
