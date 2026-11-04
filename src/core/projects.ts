import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Row, readRows } from "./rows.js";
import type { SqliteDatabase } from "./sqlite.js";

/**
 * Where an OpenCode 2 session belongs.
 *
 * OpenCode 2 lists only the sessions of the project it resolves for the
 * current directory. A session whose `project_id` this machine would resolve
 * differently exists in the database but never shows up in `/session`. Every
 * imported session, and every session OpenCode itself migrated from 1.x, is
 * therefore placed the way OpenCode 2 would place it here:
 *
 *   - the newest project whose worktree is the session directory, or the
 *     deepest git worktree that contains it;
 *   - otherwise a project created with the id OpenCode 2 derives itself
 *     (`sha1("directory:" + path)` for a plain directory);
 *   - otherwise, for a directory this machine does not have, the home
 *     directory's project, which is where `/session` is normally opened.
 *
 * Project ids are deterministic in OpenCode 2 (git remote, root commit or
 * directory path), so a project row from another machine is reused as is when
 * its worktree also exists here.
 */

export const GLOBAL_PROJECT_ID = "global";

export interface Placement {
  projectId: string;
  directory: string;
  path: string | null;
  /** Parked in the home project because no project matches the directory. */
  parked: boolean;
}

export interface PlacementInput {
  directory: string;
  projectId: string;
  path: string | null;
  /** The exporting machine's home directory, to map paths under it. */
  originHome?: string;
}

export interface PlacementOptions {
  /** This machine's home directory. */
  home: string;
  /** Create project rows OpenCode 2 would create itself. */
  createProjects: boolean;
  now: number;
  /** Test seam: whether a directory exists on this machine. */
  exists?: (dir: string) => boolean;
}

interface ProjectRow {
  id: string;
  worktree: string;
  vcs: string | null;
  time_created: number;
}

const caseInsensitive = process.platform !== "linux";

/** OpenCode 2 stores Windows paths with forward slashes. */
export function storedPath(p: string): string {
  let out = process.platform === "win32" ? p.replace(/\\/g, "/") : p;
  while (out.length > 1 && out.endsWith("/") && !/^[A-Za-z]:\/$/.test(out)) out = out.slice(0, -1);
  return out;
}

function key(p: string): string {
  const s = String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return caseInsensitive ? s.toLowerCase() : s;
}

/** The project id OpenCode 2 gives a directory outside any repository. */
export function directoryProjectId(directory: string): string {
  return createHash("sha1")
    .update(`directory:${path.resolve(directory)}`)
    .digest("hex");
}

export function homeDir(): string {
  return process.env.SYNC_HOME || os.homedir();
}

/** Relative path from a worktree to a directory, the way OpenCode 2 writes it. */
export function relativePath(
  directory: string,
  worktree: string,
  fallback: string | null,
): string | null {
  const d = key(directory);
  const w = key(worktree);
  if (d === w) return "";
  if (d.startsWith(`${w}/`)) return storedPath(directory).slice(storedPath(worktree).length + 1);
  const rel = path.relative(path.resolve(worktree), path.resolve(directory));
  if (!rel || path.isAbsolute(rel)) return fallback;
  return rel.replace(/\\/g, "/");
}

function insideRepository(directory: string, exists: (dir: string) => boolean): boolean {
  let current = path.resolve(directory);
  for (;;) {
    if (exists(path.join(current, ".git")) || exists(path.join(current, ".hg"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export class ProjectResolver {
  private projects: ProjectRow[];
  private readonly exists: (dir: string) => boolean;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: PlacementOptions,
  ) {
    this.exists = options.exists ?? ((dir) => fs.existsSync(dir));
    this.projects = this.load();
  }

  private load(): ProjectRow[] {
    return readRows(this.db, "SELECT id, worktree, vcs, time_created FROM project WHERE id <> ?", [
      GLOBAL_PROJECT_ID,
    ]).map((row) => ({
      id: String(row.id),
      worktree: String(row.worktree ?? ""),
      vcs: row.vcs == null ? null : String(row.vcs),
      time_created: Number(row.time_created ?? 0),
    }));
  }

  /** The project OpenCode 2 resolves today for a directory, if it has one. */
  resolve(directory: string): ProjectRow | undefined {
    const d = key(directory);
    const newest = new Map<string, ProjectRow>();
    for (const p of this.projects) {
      const k = key(p.worktree);
      if (!k || k === "/") continue;
      const prev = newest.get(k);
      if (!prev || p.time_created > prev.time_created) newest.set(k, p);
    }
    let best: ProjectRow | undefined;
    for (const [k, p] of newest) {
      const match = d === k || (p.vcs && d.startsWith(`${k}/`));
      if (match && (!best || k.length > key(best.worktree).length)) best = p;
    }
    return best;
  }

  /** Insert another machine's project row when its worktree exists here too. */
  adopt(project: Row | undefined, insert: (row: Row) => void): void {
    if (!project || String(project.id) === GLOBAL_PROJECT_ID) return;
    const worktree = String(project.worktree ?? "");
    if (!worktree || !this.exists(worktree)) return;
    if (this.projects.some((p) => p.id === String(project.id))) return;
    insert(project);
    this.projects = this.load();
  }

  private createDirectoryProject(directory: string): ProjectRow | undefined {
    if (!this.options.createProjects) return undefined;
    if (!this.exists(directory) || insideRepository(directory, this.exists)) return undefined;
    const id = directoryProjectId(directory);
    const now = this.options.now;
    this.db
      .prepare(
        `INSERT INTO project (id, worktree, vcs, sandboxes, time_created, time_updated, time_active)
         VALUES (?, ?, NULL, '[]', ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(id, storedPath(path.resolve(directory)), now, now, now);
    this.projects = this.load();
    return this.projects.find((p) => p.id === id);
  }

  private home(): ProjectRow | undefined {
    const home = this.options.home;
    return this.resolve(storedPath(path.resolve(home))) ?? this.createDirectoryProject(home);
  }

  /** Map a directory under the exporting machine's home onto this machine's home. */
  private translate(directory: string, originHome: string | undefined): string {
    if (this.exists(directory) || !originHome) return directory;
    const from = key(originHome);
    const d = key(directory);
    if (!d.startsWith(`${from}/`)) return directory;
    const rest = storedPath(directory).slice(storedPath(originHome).length + 1);
    const candidate = path.join(this.options.home, ...rest.split("/"));
    return this.exists(candidate) ? storedPath(candidate) : directory;
  }

  /** Where a session belongs on this machine. */
  place(session: PlacementInput): Placement {
    const directory = this.translate(session.directory, session.originHome);
    const target = this.resolve(directory) ?? this.createDirectoryProject(directory);
    if (target) {
      const exact = key(directory) === key(target.worktree);
      return {
        projectId: target.id,
        directory: exact ? target.worktree : storedPath(directory),
        path: relativePath(directory, target.worktree, session.path),
        parked: false,
      };
    }
    const home = this.home();
    if (!home) {
      return {
        projectId: session.projectId,
        directory: session.directory,
        path: session.path,
        parked: false,
      };
    }
    // A directory this machine does not have would reopen in a missing
    // folder, so the session moves to the home worktree itself.
    if (!this.exists(directory)) {
      return { projectId: home.id, directory: home.worktree, path: "", parked: true };
    }
    return {
      projectId: home.id,
      directory: storedPath(directory),
      path: relativePath(directory, home.worktree, session.path),
      parked: true,
    };
  }
}
