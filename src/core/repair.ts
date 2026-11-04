import fs from "node:fs";
import { GLOBAL_PROJECT_ID, ProjectResolver, homeDir } from "./projects.js";
import { readRows } from "./rows.js";
import { hasTable, openDatabase } from "./sqlite.js";

/**
 * Move OpenCode 2 sessions into the project OpenCode 2 resolves for them.
 *
 * OpenCode 2 lists only the current project's sessions. Two kinds of session
 * end up listed nowhere after an upgrade from 1.x, although their content is
 * intact:
 *
 *   - OpenCode 1 put every session outside a repository in the synthetic
 *     `global` project. OpenCode 2 gives such a directory its own project, so
 *     migrated `global` sessions are invisible.
 *   - A repository can have several project rows for one worktree (a new id
 *     after its history changed). OpenCode 2 uses the newest; sessions under
 *     the older rows are invisible.
 *
 * Only the project, directory spelling and relative path of a session change.
 * Sessions already in the right project are not touched. A `global` session
 * whose directory has no project yet is parked in the home project; any other
 * unresolved session is left alone and reported. No project rows are created:
 * OpenCode creates them itself the first time it opens a directory.
 */

export interface RepairMove {
  id: string;
  from: string;
  to: string;
  parked: boolean;
}

export interface RepairResult {
  /** False when the database is not an OpenCode 2 database. */
  supported: boolean;
  sessions: number;
  moves: RepairMove[];
  /** `global` sessions with no project to move to, by directory. */
  unresolved: { directory: string; count: number }[];
  applied: number;
}

export interface RepairOptions {
  apply: boolean;
  home?: string;
}

export async function repairSessions(
  databaseFile: string,
  options: RepairOptions,
): Promise<RepairResult> {
  const result: RepairResult = {
    supported: false,
    sessions: 0,
    moves: [],
    unresolved: [],
    applied: 0,
  };
  if (!fs.existsSync(databaseFile)) return result;

  const db = await openDatabase(databaseFile, { readOnly: !options.apply });
  try {
    if (!hasTable(db, "session_v2")) return result;
    result.supported = true;

    const resolver = new ProjectResolver(db, {
      home: options.home ?? homeDir(),
      createProjects: false,
      now: Date.now(),
    });
    const sessions = readRows(db, "SELECT id, project_id, directory, path FROM session_v2");
    result.sessions = sessions.length;

    const updates: { id: string; project: string; directory: string; path: string | null }[] = [];
    const unresolved = new Map<string, number>();
    for (const row of sessions) {
      const current = String(row.project_id ?? "");
      const directory = String(row.directory ?? "");
      const resolved = resolver.resolve(directory);
      // Neither placed by a project here nor invisible: leave it as it is.
      if (!resolved && current !== GLOBAL_PROJECT_ID) continue;
      if (resolved && resolved.id === current) continue;

      const placement = resolver.place({
        directory,
        projectId: current,
        path: row.path == null ? null : String(row.path),
      });
      if (placement.projectId === current) {
        unresolved.set(directory, (unresolved.get(directory) ?? 0) + 1);
        continue;
      }
      result.moves.push({
        id: String(row.id),
        from: current,
        to: placement.projectId,
        parked: placement.parked,
      });
      updates.push({
        id: String(row.id),
        project: placement.projectId,
        directory: placement.directory,
        path: placement.path,
      });
    }
    result.unresolved = [...unresolved].map(([directory, count]) => ({ directory, count }));

    if (options.apply && updates.length > 0) {
      const statement = db.prepare(
        "UPDATE session_v2 SET project_id = ?, directory = ?, path = ? WHERE id = ?",
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const u of updates) statement.run(u.project, u.directory, u.path, u.id);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      result.applied = updates.length;
    }
  } finally {
    db.close();
  }
  return result;
}
