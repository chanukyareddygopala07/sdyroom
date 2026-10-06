import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { deleteUsersById } from "./admin";
import { integrationEnv } from "./env";

export const TEST_PASSWORD = "Integration!Pass123";

/**
 * Unique per process so aliases and emails never collide with a previous run
 * or with another test file in the same database.
 */
const RUN_ID = Date.now().toString(36).slice(-6);

let sequence = 0;

export type TestUser = {
  id: string;
  email: string;
  password: string;
  /** Authenticated in-memory client: the role RLS is asserted against. */
  client: SupabaseClient;
};

function anonymousClient(): SupabaseClient {
  const { apiUrl, publishableKey } = integrationEnv();
  return createClient(apiUrl, publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Creates a real user through Supabase Auth — the only way fixtures are made
 * here. No rows are inserted directly, and no service-role client is involved:
 * the client below is a normal publishable-key client that ends up bound to
 * the signed-in user.
 */
export async function createUser(label: string): Promise<TestUser> {
  sequence += 1;
  const email = `sdyroom+${RUN_ID}-${sequence}-${label}@example.com`;
  const client = anonymousClient();

  const { data, error } = await client.auth.signUp({
    email,
    password: TEST_PASSWORD,
  });
  if (error) {
    throw new Error(`signUp failed for ${email}: ${error.message}`);
  }
  if (!data.user || !data.session) {
    throw new Error(
      `signUp for ${email} returned no session. The local stack must run with ` +
        "enable_confirmations = false (supabase/config.toml) so Auth hands back " +
        "a session immediately.",
    );
  }

  return { id: data.user.id, email, password: TEST_PASSWORD, client };
}

/**
 * Removes exactly the users created by the test file that owns them. Cascade
 * deletes take their profiles, rooms and memberships with them; nothing else
 * in the database is touched.
 */
export async function deleteUsers(users: TestUser[]): Promise<void> {
  deleteUsersById(users.map((user) => user.id));
}

/** Unique, database-legal alias (1–32 chars, trimmed). */
export function uniqueAlias(label: string): string {
  sequence += 1;
  const alias = `${label}${RUN_ID}${sequence}`;
  if (alias.length > 32) {
    throw new Error(`Alias label too long: ${alias}`);
  }
  return alias;
}

/** Unique room name, so search assertions cannot match another file's rows. */
export function uniqueName(label: string): string {
  sequence += 1;
  return `${label} ${RUN_ID}${sequence}`;
}
