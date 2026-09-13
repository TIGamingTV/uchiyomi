// Opt-in deletion of chapter files everybody has already finished.
//
// This is the only scheduled task in the product that deletes a file the user never pointed at, so the
// rules it follows are deliberately timid and are the whole point of the module:
//
//  * It is off by default and the flag is re-read on every tick, so turning it off stops it immediately.
//  * "Read" means read by EVERYONE who has an opinion. A chapter with a completed row for Alice and a
//    half-finished row for Bob is not read; deleting it would take the file out from under Bob mid-series.
//    A chapter nobody has ever opened has no rows at all and is therefore never touched -- "no opinions"
//    must not collapse into "unanimously finished", which is what a bare NOT EXISTS check would do.
//  * The clock is read_progress.updated_at, which is the LAST touch rather than the moment of finishing.
//    That is conservative in the right direction: re-opening a finished chapter pushes its deletion back.
//
// The row survives; only the file goes. See lib_books.pruned_at in migrate.ts for why that is not laziness:
// read_progress.book_id is ON DELETE RESTRICT, so erasing the row would mean erasing reading history, and
// the updater treats the surviving row as "we have this number" -- which is what stops the next sweep
// re-downloading everything this job just deleted. Without that, cleanup and updater would fight for ever.
import { rm, stat } from 'fs/promises';
import { q, pool } from './db';
import { allWritable, containedPath } from './fsGuard';

// Separate from the other jobs' locks, and taken with try_ rather than blocking: if another replica is
// already pruning, the loser should decline rather than queue up and then delete the same files twice.
const CLEANUP_LOCK = 8_263_198;

export interface CleanupProgress {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  /** Files actually removed from disk. */
  deleted: number;
  bytes: number;
  ms: number | null;
  /** Set when the job declined to run at all, e.g. a read-only library mount. */
  skipped: string | null;
}

export const cleanupState: CleanupProgress = {
  running: false,
  startedAt: null,
  finishedAt: null,
  deleted: 0,
  bytes: 0,
  ms: null,
  skipped: null,
};

interface Candidate { id: string; root: string; file: string; series_id: string }

/**
 * Chapters whose file may go: read to completion by every user who has touched them, by at least one user,
 * and untouched since `days` days ago.
 *
 * Exported so the admin UI can say "this would delete N files" before anyone turns the thing on, and so the
 * selection rule can be tested without a filesystem.
 */
export function candidates(days: number): Promise<Candidate[]> {
  return q<Candidate>(
    `SELECT b.id, b.root, b.file, b.series_id
       FROM lib_books b
      WHERE b.pruned_at IS NULL
        -- at least one person finished it ...
        AND EXISTS (SELECT 1 FROM read_progress r WHERE r.book_id = b.id AND r.completed)
        -- ... and nobody is part-way through it
        AND NOT EXISTS (SELECT 1 FROM read_progress r WHERE r.book_id = b.id AND NOT r.completed)
        AND (SELECT max(r.updated_at) FROM read_progress r WHERE r.book_id = b.id)
            < now() - make_interval(days => $1::int)`,
    [days],
  );
}

/**
 * How many files the job would delete right now.
 *
 * A count rather than `candidates().length`: the admin Tasks panel calls this on every poll, and on a large
 * library the row-fetching version hauls back a path per eligible chapter to then throw all of them away.
 */
export async function cleanupPending(days: number): Promise<number> {
  const rows = await q<{ n: string }>(
    `SELECT count(*)::text n
       FROM lib_books b
      WHERE b.pruned_at IS NULL
        AND EXISTS (SELECT 1 FROM read_progress r WHERE r.book_id = b.id AND r.completed)
        AND NOT EXISTS (SELECT 1 FROM read_progress r WHERE r.book_id = b.id AND NOT r.completed)
        AND (SELECT max(r.updated_at) FROM read_progress r WHERE r.book_id = b.id)
            < now() - make_interval(days => $1::int)`,
    [days],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Delete the files for every eligible chapter and mark the rows pruned.
 *
 * Returns null if it declined to start (already running here, or another replica holds the lock), so the
 * caller can report "busy" rather than an empty success.
 */
export async function runReadCleanup(
  days: number,
  log?: { info: (m: string) => void; error: (e: any) => void },
): Promise<CleanupProgress | null> {
  if (cleanupState.running) return null;

  const client = await pool.connect();
  try {
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [CLEANUP_LOCK]);
    if (!got.rows[0]?.ok) return null;
  } catch {
    client.release();
    return null;
  }

  cleanupState.running = true;
  cleanupState.startedAt = Date.now();
  cleanupState.finishedAt = null;
  cleanupState.deleted = 0;
  cleanupState.bytes = 0;
  cleanupState.ms = null;
  cleanupState.skipped = null;
  const t0 = Date.now();

  try {
    const rows = await candidates(days);
    if (rows.length) {
      // All-or-nothing on writability, for the same reason the series rename insists on it: half-deleting a
      // series across a writable download dir and a read-only library mount leaves a mess nobody asked for.
      const roots = [...new Set(rows.map((r) => r.root).filter(Boolean))];
      const w = await allWritable(roots);
      if (!w.ok) {
        cleanupState.skipped = w.reason;
        log?.info(`cleanup: skipped, ${w.reason}`);
      } else {
        const pruned = new Set<string>();
        for (const b of rows) {
          // Containment first: `file` is a relative path from a scan, and a refusal here is a refusal, never
          // a reason to fall back to the raw value.
          const abs = containedPath(b.root, b.file);
          if (!abs) continue;
          const st = await stat(abs).catch(() => null);
          try {
            await rm(abs, { recursive: true, force: true });
          } catch (e) {
            log?.error(e);
            continue; // leave the row unpruned, so the file stays visible and we retry next run
          }
          if (st) cleanupState.bytes += st.size;
          cleanupState.deleted++;
          pruned.add(b.id);
        }

        if (pruned.size) {
          await q('UPDATE lib_books SET pruned_at = now() WHERE id = ANY($1)', [[...pruned]]);
          // The rollups now disagree with what the catalogue will show. Re-point any cover that pointed at a
          // file we just deleted, or every cover and backdrop for that series breaks.
          const series = [...new Set(rows.filter((r) => pruned.has(r.id)).map((r) => r.series_id))];
          // A scalar subquery rather than the UPDATE ... FROM (GROUP BY) shape used elsewhere: a series whose
          // every chapter was just pruned produces no group, so that shape would silently leave its old count
          // standing -- which is the one case this job is guaranteed to create.
          await q(
            `UPDATE lib_series s SET books_count = (
               SELECT count(*) FROM lib_books b WHERE b.series_id = s.id AND b.pruned_at IS NULL
             ) WHERE s.id = ANY($1)`,
            [series],
          );
          await q(
            `UPDATE lib_series SET cover_book_id = (
               SELECT id FROM lib_books WHERE series_id = lib_series.id AND pruned_at IS NULL
                ORDER BY number ASC, file ASC LIMIT 1
             ) WHERE id = ANY($1)`,
            [series],
          );
        }
        log?.info(`cleanup: deleted ${cleanupState.deleted} read chapter(s), ${(cleanupState.bytes / 1024 / 1024).toFixed(1)} MB`);
      }
    }
  } finally {
    cleanupState.running = false;
    cleanupState.finishedAt = Date.now();
    cleanupState.ms = Date.now() - t0;
    await client.query('SELECT pg_advisory_unlock($1)', [CLEANUP_LOCK]).catch(() => {});
    client.release();
    // Persisted so the Tasks panel still reports it after a restart, like the backup does.
    await q(
      'UPDATE server_settings SET cleanup_last_run = now(), cleanup_last_result = $1 WHERE id = 1',
      [JSON.stringify({ deleted: cleanupState.deleted, bytes: cleanupState.bytes, ms: cleanupState.ms, skipped: cleanupState.skipped })],
    ).catch(() => {});
  }

  return cleanupState;
}
