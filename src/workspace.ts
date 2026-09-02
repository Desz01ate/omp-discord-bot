import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from "fs";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { spawn } from "bun";

export const DISCORD_INLINE_DIFF_LIMIT = 1900;
export const MAX_WORKSPACE_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runGitCommand(cwd: string, args: string[]): Promise<GitCommandResult> {
  try {
    const proc = spawn(["git", "-c", "safe.directory=*", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (error) {
    return {
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function pathIsInside(targetPath: string, rootDir: string): boolean {
  const rel = relative(resolve(rootDir), resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Returns true when targetPath is within rootDir. Existing symlinks are
 * resolved as well, so a link inside the workspace cannot expose a file
 * outside of it.
 */
export function isInsideWorkspace(targetPath: string, rootDir: string): boolean {
  if (!pathIsInside(targetPath, rootDir)) return false;
  try {
    const realRoot = realpathSync(rootDir);
    const realTarget = realpathSync(targetPath);
    return pathIsInside(realTarget, realRoot);
  } catch {
    // A path may not exist yet (for example, a new worktree target). The
    // lexical check still prevents ../ traversal in that case.
    return true;
  }
}

export interface GitRepositoryInfo {
  root: string;
  gitDir: string;
}

export async function getGitRepositoryInfo(cwd: string): Promise<GitRepositoryInfo | null> {
  const repoCheck = await runGitCommand(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (repoCheck.code !== 0 || repoCheck.stdout.trim() !== "true") return null;

  const [rootResult, gitDirResult] = await Promise.all([
    runGitCommand(cwd, ["rev-parse", "--show-toplevel"]),
    runGitCommand(cwd, ["rev-parse", "--git-common-dir"]),
  ]);
  const root = rootResult.stdout.trim();
  const commonDir = gitDirResult.stdout.trim();
  if (rootResult.code !== 0 || gitDirResult.code !== 0 || !root || !commonDir) return null;
  return {
    root: resolve(root),
    gitDir: resolve(root, commonDir),
  };
}

export interface GitDiffOptions {
  staged?: boolean;
  path?: string;
}

export interface GitDiffResult {
  isRepo: boolean;
  hasChanges: boolean;
  hasDiff: boolean;
  staged: boolean;
  path?: string;
  status: string;
  diff: string;
  stat: string;
  summary: string;
  error?: string;
}

function normalizePathFilter(cwd: string, pathFilter?: string): { value?: string; error?: string } {
  if (!pathFilter?.trim()) return {};
  const requested = pathFilter.trim();
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested);
  if (!isInsideWorkspace(absolute, cwd)) {
    return { error: "Path filter must be inside the session workspace." };
  }
  const value = relative(cwd, absolute) || ".";
  return { value };
}

function gitPathArgs(pathFilter: string | undefined): string[] {
  return pathFilter ? ["--", pathFilter] : [];
}

function summarizeStatus(status: string): string {
  const lines = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) return "No changed files.";
  const counts = new Map<string, number>();
  for (const line of lines) {
    const code = line.slice(0, 2).trim() || "?";
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const breakdown = Array.from(counts, ([code, count]) => `${code}: ${count}`).join(", ");
  return `${lines.length} changed file${lines.length === 1 ? "" : "s"} (${breakdown}).`;
}

export async function inspectGitDiff(cwd: string, options: GitDiffOptions = {}): Promise<GitDiffResult> {
  const staged = options.staged === true;
  const pathResult = normalizePathFilter(cwd, options.path);
  if (pathResult.error) {
    return {
      isRepo: true,
      hasChanges: false,
      hasDiff: false,
      staged,
      path: options.path,
      status: "",
      diff: "",
      stat: "",
      summary: "",
      error: pathResult.error,
    };
  }

  const repo = await getGitRepositoryInfo(cwd);
  if (!repo) {
    return {
      isRepo: false,
      hasChanges: false,
      hasDiff: false,
      staged,
      path: pathResult.value,
      status: "",
      diff: "",
      stat: "",
      summary: "",
      error: "This workspace is not a Git repository.",
    };
  }

  const pathArgs = gitPathArgs(pathResult.value);
  const statusResult = await runGitCommand(cwd, ["status", "--short", "--untracked-files=all", ...pathArgs]);
  if (statusResult.code !== 0) {
    return {
      isRepo: true,
      hasChanges: false,
      hasDiff: false,
      staged,
      path: pathResult.value,
      status: "",
      diff: "",
      stat: "",
      summary: "",
      error: statusResult.stderr.trim() || "Unable to inspect Git status.",
    };
  }

  const diffArgs = ["diff", ...(staged ? ["--cached"] : []), "--no-ext-diff", "--binary", ...pathArgs];
  const [diffResult, statResult] = await Promise.all([
    runGitCommand(cwd, diffArgs),
    runGitCommand(cwd, ["diff", ...(staged ? ["--cached"] : []), "--stat", ...pathArgs]),
  ]);
  if (diffResult.code !== 0) {
    return {
      isRepo: true,
      hasChanges: statusResult.stdout.trim().length > 0,
      hasDiff: false,
      staged,
      path: pathResult.value,
      status: statusResult.stdout,
      diff: "",
      stat: "",
      summary: summarizeStatus(statusResult.stdout),
      error: diffResult.stderr.trim() || "Unable to inspect Git diff.",
    };
  }

  const diff = diffResult.stdout;
  const status = statusResult.stdout;
  return {
    isRepo: true,
    hasChanges: status.trim().length > 0,
    hasDiff: diff.length > 0,
    staged,
    path: pathResult.value,
    status,
    diff,
    stat: statResult.stdout,
    summary: summarizeStatus(status),
  };
}

export interface DiscordDiffOutput {
  inline: boolean;
  content?: string;
  attachment?: Buffer;
  filename?: string;
}

export function formatDiffForDiscord(diff: string): DiscordDiffOutput {
  if (diff.length <= DISCORD_INLINE_DIFF_LIMIT) {
    return {
      inline: true,
      content: `\`\`\`diff\n${diff}\n\`\`\``,
    };
  }
  return {
    inline: false,
    attachment: Buffer.from(diff, "utf8"),
    filename: "git-diff.diff",
  };
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  repoRoot: string;
  gitDir: string;
}

export interface WorktreeResult {
  ok: boolean;
  worktree?: WorktreeInfo;
  error?: string;
  output?: string;
}

export async function createGitWorktree(cwd: string, threadId: string): Promise<WorktreeResult> {
  const repo = await getGitRepositoryInfo(cwd);
  if (!repo) return { ok: false, error: "This workspace is not a Git repository." };

  const branch = `discord/${threadId}`;
  const worktreePath = join(repo.root, ".omp-worktrees", threadId);
  if (existsSync(worktreePath)) {
    return { ok: false, error: `A worktree already exists for thread ${threadId}.` };
  }

  const result = await runGitCommand(repo.root, ["worktree", "add", "-b", branch, worktreePath]);
  if (result.code !== 0) {
    return { ok: false, error: result.stderr.trim() || result.stdout.trim() || "Unable to create a Git worktree." };
  }
  return {
    ok: true,
    worktree: { path: worktreePath, branch, repoRoot: repo.root, gitDir: repo.gitDir },
    output: result.stdout.trim(),
  };
}

export async function removeGitWorktree(worktree: WorktreeInfo): Promise<boolean> {
  const worktreeRoot = join(worktree.repoRoot, ".omp-worktrees");
  if (!pathIsInside(worktree.path, worktreeRoot) || resolve(worktree.path) === resolve(worktreeRoot)) {
    console.error(`Refusing to remove worktree outside OMP worktrees directory: ${worktree.path}`);
    return false;
  }

  const result = await runGitCommand(worktree.repoRoot, ["worktree", "remove", "--force", worktree.path]);
  if (result.code !== 0 && existsSync(worktree.path)) {
    console.error(`Failed to remove Git worktree ${worktree.path}:`, result.stderr.trim() || result.stdout.trim());
    return false;
  }
  if (existsSync(worktree.path)) {
    try {
      rmSync(worktree.path, { recursive: true, force: true });
    } catch (error) {
      console.error(`Failed to remove worktree directory ${worktree.path}:`, error);
      return false;
    }
  }
  await runGitCommand(worktree.repoRoot, ["worktree", "prune"]);
  return true;
}

export interface CommitResult {
  ok: boolean;
  committed: boolean;
  staged: boolean;
  hash?: string;
  error?: string;
  output?: string;
}

export async function commitWorkspaceChanges(cwd: string, message: string): Promise<CommitResult> {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    return { ok: false, committed: false, staged: false, error: "Commit message cannot be empty." };
  }
  const repo = await getGitRepositoryInfo(cwd);
  if (!repo) {
    return { ok: false, committed: false, staged: false, error: "This workspace is not a Git repository." };
  }

  const stagedCheck = await runGitCommand(cwd, ["diff", "--cached", "--quiet"]);
  if (stagedCheck.code > 1) {
    return {
      ok: false,
      committed: false,
      staged: false,
      error: stagedCheck.stderr.trim() || "Unable to inspect staged changes.",
    };
  }
  let staged = stagedCheck.code === 1;
  if (!staged) {
    const addResult = await runGitCommand(cwd, ["add", "-u"]);
    if (addResult.code !== 0) {
      return {
        ok: false,
        committed: false,
        staged: false,
        error: addResult.stderr.trim() || addResult.stdout.trim() || "Unable to stage tracked changes.",
      };
    }
    const afterAdd = await runGitCommand(cwd, ["diff", "--cached", "--quiet"]);
    if (afterAdd.code > 1) {
      return {
        ok: false,
        committed: false,
        staged: false,
        error: afterAdd.stderr.trim() || "Unable to inspect staged changes.",
      };
    }
    staged = afterAdd.code === 1;
  }

  if (!staged) {
    return { ok: true, committed: false, staged: false, output: "No tracked changes to commit." };
  }

  const commitResult = await runGitCommand(cwd, ["commit", "-m", trimmedMessage]);
  if (commitResult.code !== 0) {
    return {
      ok: false,
      committed: false,
      staged: true,
      error: commitResult.stderr.trim() || commitResult.stdout.trim() || "Git commit failed.",
    };
  }
  const hashResult = await runGitCommand(cwd, ["rev-parse", "--short", "HEAD"]);
  return {
    ok: true,
    committed: true,
    staged: true,
    hash: hashResult.stdout.trim() || undefined,
    output: commitResult.stdout.trim(),
  };
}

export interface WorkspaceFile {
  absolutePath: string;
  relativePath: string;
  size: number;
}

export interface WorkspaceFileResult {
  ok: boolean;
  file?: WorkspaceFile;
  error?: string;
}

export function resolveWorkspaceFile(cwd: string, requestedPath: string): WorkspaceFileResult {
  const raw = requestedPath.trim();
  if (!raw) return { ok: false, error: "Please provide a file path." };
  const absolutePath = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  if (!isInsideWorkspace(absolutePath, cwd)) {
    return { ok: false, error: "That path is outside the session workspace." };
  }
  try {
    const fileStat = statSync(absolutePath);
    if (!fileStat.isFile()) return { ok: false, error: "The requested path is not a regular file." };
    return {
      ok: true,
      file: {
        absolutePath,
        relativePath: relative(resolve(cwd), absolutePath) || basename(absolutePath),
        size: fileStat.size,
      },
    };
  } catch {
    return { ok: false, error: "That file does not exist in the session workspace." };
  }
}

function collectWorkspaceFiles(rootDir: string, dir: string, output: WorkspaceFile[], limit: number): void {
  if (output.length >= limit) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (output.length >= limit) return;
    if (entry.name === ".git" || entry.name === ".discord-attachments" || entry.name === ".omp-worktrees" || entry.name === "node_modules") continue;
    const fullPath = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        collectWorkspaceFiles(rootDir, fullPath, output, limit);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const resolved = resolveWorkspaceFile(rootDir, fullPath);
        if (resolved.ok && resolved.file) output.push(resolved.file);
      }
    } catch {
      // A concurrently removed or unreadable entry is not an autocomplete result.
    }
  }
}

export function listWorkspaceFiles(rootDir: string, query = "", limit = 1000): WorkspaceFile[] {
  const files: WorkspaceFile[] = [];
  collectWorkspaceFiles(resolve(rootDir), resolve(rootDir), files, limit);
  const normalizedQuery = query.trim().toLowerCase();
  return files
    .filter((file) => !normalizedQuery || file.relativePath.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function isDownloadableWorkspaceFile(file: WorkspaceFile): boolean {
  return file.size <= MAX_WORKSPACE_DOWNLOAD_BYTES;
}

// Keep lstat imported as a compatibility guard for runtimes whose Dirent
// implementation reports symlinks inconsistently.
export function isRegularWorkspaceFile(path: string): boolean {
  try {
    return statSync(path).isFile() && !lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
