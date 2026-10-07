import { psql } from "../integration/helpers/admin";

/**
 * Removes every user this run created (`e2e+<run>-…` emails). Cascade takes
 * their profiles, rooms, memberships, sessions, goals, messages and study
 * resources with them, so the database is left as it was found. Runs in the
 * main process after the suite; it never touches other runs' rows or anything
 * outside the local container.
 */
export default async function globalTeardown(): Promise<void> {
  const runId = process.env.E2E_RUN_ID;
  if (!runId || !/^[a-z0-9]+$/.test(runId)) {
    throw new Error(`Refusing to clean up with a malformed E2E_RUN_ID: ${runId}`);
  }

  // Storage objects are not cascaded: `storage.objects` has no foreign key to
  // `auth.users`, so the files have to go first, while the owner ids still
  // resolve. `protect_delete()` blocks a direct DELETE unless the session
  // opts in, hence the `set` riding along in the same statement.
  psql(
    `set storage.allow_delete_query = 'true'; ` +
      `delete from storage.objects ` +
      `where bucket_id = 'study-resources' ` +
      `and owner in (select id from auth.users where email like 'e2e+${runId}%');`,
  );

  // The count comes back as the single column of a SELECT: a plain
  // `delete ... returning` would append psql's own "DELETE n" status line and
  // the prefix (`e2e+<run>…`, run ids are fixed length) cannot overlap a
  // different run's users.
  const output = psql(
    `with removed as (delete from auth.users ` +
      `where email like 'e2e+${runId}%' returning 1) ` +
      `select count(*) from removed;`,
  );
  const count = Number(output.trim());
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Unexpected cleanup result: ${JSON.stringify(output)}`);
  }
  process.stdout.write(`e2e teardown: removed ${count} run user(s).\n`);
}
