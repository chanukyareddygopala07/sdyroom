import type { SupabaseClient } from "@supabase/supabase-js";

export type Profile = {
  id: string;
  alias: string;
};

export class ProfileQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileQueryError";
  }
}

export type ProfileErrorCode =
  | "alias_taken"
  | "already_exists"
  | "forbidden"
  | "query_failed";

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;
  readonly status: number;

  constructor(code: ProfileErrorCode, message: string, status: number) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Reads a profile through RLS: the caller only ever sees their own row, so a
 * missing row means "not onboarded" rather than "does not exist".
 */
export async function getProfile(
  client: SupabaseClient,
  userId: string,
): Promise<Profile | null> {
  const { data, error } = await client
    .from("profiles")
    .select("id, alias")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw new ProfileQueryError(error.message);
  }

  if (!data) {
    return null;
  }

  return { id: String(data.id), alias: String(data.alias) };
}

/**
 * Creates the profile row for the authenticated user. The id is the caller's
 * own user id — the RLS policy only allows `id = auth.uid()`.
 * Case-insensitive alias collisions arrive as 23505 on
 * `profiles_alias_lower_key` and are surfaced as `alias_taken`.
 */
export async function createProfile(
  client: SupabaseClient,
  userId: string,
  alias: string,
): Promise<Profile> {
  const { data, error } = await client
    .from("profiles")
    .insert({ id: userId, alias })
    .select("id, alias")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      if (error.message.includes("profiles_alias_lower_key")) {
        throw new ProfileError(
          "alias_taken",
          "That study alias is already taken. Try another one.",
          409,
        );
      }
      if (error.message.includes("profiles_pkey")) {
        throw new ProfileError(
          "already_exists",
          "You already chose a study alias.",
          409,
        );
      }
    }

    if (error.code === "42501") {
      throw new ProfileError(
        "forbidden",
        "You can only create your own profile.",
        403,
      );
    }

    throw new ProfileError(
      "query_failed",
      "Your study alias could not be saved. Please try again.",
      500,
    );
  }

  if (!data) {
    throw new ProfileError(
      "query_failed",
      "Your study alias could not be saved. Please try again.",
      500,
    );
  }

  return { id: String(data.id), alias: String(data.alias) };
}
