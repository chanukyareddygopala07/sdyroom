import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommunityRole } from "@/lib/communities/types";

/**
 * Access errors for the community subsystem. The route maps these onto the
 * standard envelope: 404 for anything the caller may not know exists (missing
 * community, no membership, banned — the same shape rooms use so routes are
 * not existence oracles), 403 only where the caller demonstrably holds
 * membership and is acting above their role.
 */
export class CommunityAccessError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "CommunityAccessError";
    this.code = code;
    this.status = status;
  }
}

export type CommunityAccess = {
  communityId: string;
  role: CommunityRole;
  status: "active";
};

/**
 * Confirm the caller is an ACTIVE member of the community and return their
 * role. Requested and banned members, and everyone else, receive the same
 * `not_found` the discovery UI gives — membership is confirmed from the
 * caller's own `community_members` row, never from a request parameter.
 */
export async function requireCommunityMembership(
  supabase: SupabaseClient,
  communityId: string,
  userId: string,
): Promise<CommunityAccess> {
  const { data, error } = await supabase
    .from("community_members")
    .select("role, status")
    .eq("community_id", communityId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`membership lookup failed: ${error.message}`);
  }

  if (!data || data.status !== "active") {
    throw new CommunityAccessError(
      "not_found",
      "That community does not exist or you do not have access to it.",
      404,
    );
  }

  return { communityId, role: data.role as CommunityRole, status: "active" };
}

/**
 * Confirm the caller is active staff (owner or moderator). Members who are
 * merely present get `forbidden`: they already know the community exists, so
 * a 404 would mislead rather than protect.
 */
export async function requireCommunityStaff(
  supabase: SupabaseClient,
  communityId: string,
  userId: string,
): Promise<CommunityAccess> {
  const access = await requireCommunityMembership(supabase, communityId, userId);
  if (access.role === "member") {
    throw new CommunityAccessError(
      "forbidden",
      "Only community owners and moderators can do that.",
      403,
    );
  }
  return access;
}

/** Confirm the caller is the community's owner. */
export async function requireCommunityOwner(
  supabase: SupabaseClient,
  communityId: string,
  userId: string,
): Promise<CommunityAccess> {
  const access = await requireCommunityStaff(supabase, communityId, userId);
  if (access.role !== "owner") {
    throw new CommunityAccessError(
      "forbidden",
      "Only the community owner can do that.",
      403,
    );
  }
  return access;
}

/**
 * Confirm the caller may see the community row itself: public rows are open
 * to every signed-in user, private rows require active membership. Used by
 * the single-community GET, which serves discovery previews as well as the
 * member view.
 */
export async function requireCommunityVisibility(
  supabase: SupabaseClient,
  communityId: string,
  userId: string,
): Promise<{ visibility: "public" | "private"; role: CommunityRole | null }> {
  const { data, error } = await supabase
    .from("communities")
    .select("visibility")
    .eq("id", communityId)
    .maybeSingle();

  if (error) {
    throw new Error(`community lookup failed: ${error.message}`);
  }
  if (!data) {
    // Same words as the private-denied branch below: within this route a
    // missing id and an invisible private community must be indistinguishable.
    throw new CommunityAccessError(
      "not_found",
      "That community does not exist or you do not have access to it.",
      404,
    );
  }

  if (data.visibility === "public") {
    const { data: membership } = await supabase
      .from("community_members")
      .select("role")
      .eq("community_id", communityId)
      .eq("user_id", userId)
      .maybeSingle();
    return { visibility: "public", role: (membership?.role as CommunityRole) ?? null };
  }

  const { data: membership, error: membershipError } = await supabase
    .from("community_members")
    .select("role, status")
    .eq("community_id", communityId)
    .eq("user_id", userId)
    .maybeSingle();

  if (membershipError) {
    throw new Error(`membership lookup failed: ${membershipError.message}`);
  }
  if (!membership || membership.status !== "active") {
    throw new CommunityAccessError(
      "not_found",
      "That community does not exist or you do not have access to it.",
      404,
    );
  }
  return { visibility: "private", role: membership.role as CommunityRole };
}
