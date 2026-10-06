import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { integrationEnv } from "./env";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let containerName: string | null = null;

/**
 * The database container name is derived from the pinned project_id in
 * supabase/config.toml so the helper never reaches for an unrelated database.
 */
function databaseContainer(): string {
  if (containerName === null) {
    const configPath = resolve(process.cwd(), "supabase", "config.toml");
    const match = readFileSync(configPath, "utf8").match(
      /^\s*project_id\s*=\s*"([^"]+)"/m,
    );
    if (!match) {
      throw new Error(`Could not read project_id from ${configPath}.`);
    }
    containerName = `supabase_db_${match[1]}`;
  }
  return containerName;
}

function runPsql(sql: string, allowFailure: boolean): { status: number | null; output: string } {
  // Local stack only: the same guard the environment validation applies, so a
  // misconfigured run can never execute SQL outside the local container.
  const { apiUrl } = integrationEnv();
  const host = new URL(apiUrl).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`Refusing to run SQL against non-local host "${host}".`);
  }

  const result = spawnSync(
    "docker",
    [
      "exec",
      databaseContainer(),
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  );

  if (result.error) {
    throw new Error(`docker exec failed: ${result.error.message}`);
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (!allowFailure && result.status !== 0) {
    throw new Error(`psql failed (exit ${result.status}): ${output}`);
  }
  return { status: result.status, output };
}

/** Runs a read-only/administrative statement and returns its unaligned output. */
export function psql(sql: string): string {
  return runPsql(sql, false).output;
}

/** Runs a statement that is expected to fail, without throwing. */
export function psqlExpectingFailure(sql: string): { status: number | null; output: string } {
  return runPsql(sql, true);
}

/** Confirms the migrations are applied before any test asserts on them. */
export function assertSchemaApplied(): void {
  const marker = psql(
    "select to_regclass('public.profiles') is not null " +
      "and to_regclass('public.rooms') is not null " +
      "and to_regclass('public.room_members') is not null " +
      "and to_regclass('public.focus_sessions') is not null " +
      "and to_regclass('public.study_goals') is not null;",
  );
  if (marker !== "t") {
    throw new Error(
      "The public.profiles / public.rooms / public.room_members / " +
        'public.focus_sessions / public.study_goals tables are missing. ' +
        'Apply the migrations with "npx supabase db reset".',
    );
  }
}

/** Deletes exactly the given auth users; cascade removes their rows only. */
export function deleteUsersById(userIds: string[]): void {
  if (userIds.length === 0) {
    return;
  }
  const list = userIds.map((id) => {
    if (!UUID_RE.test(id)) {
      throw new Error(`Refusing to delete a malformed user id: ${JSON.stringify(id)}`);
    }
    return `'${id}'`;
  });
  psql(`delete from auth.users where id in (${list.join(", ")});`);
}

/** Authoritative row count for one user, ignoring RLS. */
export function countRoomsOwnedBy(userId: string): number {
  if (!UUID_RE.test(userId)) {
    throw new Error(`Refusing to query a malformed user id: ${JSON.stringify(userId)}`);
  }
  return Number(psql(`select count(*) from public.rooms where owner_id = '${userId}';`));
}

export function roomMembersInsertGranted(): boolean {
  return (
    psql(
      "select has_table_privilege('authenticated', 'public.room_members', 'insert');",
    ) === "t"
  );
}
