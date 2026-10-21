import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CommunityAttachmentRow,
  CommunityChannelRow,
  CommunityDeviceRow,
  CommunityMessageRow,
  CommunityReportRow,
  CommunityRow,
  CommunityWelcomeRow,
} from "@/lib/communities/types";

/**
 * Community query errors. Routes map these onto the standard envelope the
 * same way rooms do: `code`/`message`/`status` travel together so the route
 * never invents prose.
 */
export class CommunityError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "CommunityError";
    this.code = code;
    this.status = code === "not_found" ? 404 : status;
  }
}

function notFound(message = "That community does not exist."): CommunityError {
  return new CommunityError("not_found", message, 404);
}

const COMMUNITY_COLUMNS =
  "id, slug, name, description, category, visibility, join_policy, rules, owner_id, member_count, created_at, updated_at";

/** Discovery list: public communities only, never private rows. */
export async function listCommunities(
  supabase: SupabaseClient,
  options: { category?: string; q?: string; limit: number },
): Promise<{ communities: CommunityRow[]; has_more: boolean }> {
  let query = supabase
    .from("communities")
    .select(COMMUNITY_COLUMNS)
    .eq("visibility", "public")
    .order("created_at", { ascending: false })
    .limit(options.limit + 1);

  if (options.category) {
    query = query.eq("category", options.category);
  }
  if (options.q) {
    query = query.or(`name.ilike.%${options.q}%,description.ilike.%${options.q}%`);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`community list failed: ${error.message}`);
  }

  const rows = (data ?? []) as CommunityRow[];
  return {
    communities: rows.slice(0, options.limit),
    has_more: rows.length > options.limit,
  };
}

export async function getCommunity(
  supabase: SupabaseClient,
  communityId: string,
): Promise<CommunityRow> {
  const { data, error } = await supabase
    .from("communities")
    .select(COMMUNITY_COLUMNS)
    .eq("id", communityId)
    .maybeSingle();

  if (error) {
    throw new Error(`community lookup failed: ${error.message}`);
  }
  if (!data) {
    throw notFound();
  }
  return data as CommunityRow;
}

/** Active member roster with display aliases, for the members view.
 * Served by the `community_roster` SECURITY DEFINER RPC: profiles is
 * SELECT-own only, so a PostgREST embed can neither see other members'
 * aliases nor reach profiles at all from community_members (no FK path). The
 * RPC re-checks active membership and gates include_requested to staff, so a
 * direct call cannot out-run the route's own gates. */
export async function listCommunityMembers(
  supabase: SupabaseClient,
  communityId: string,
  options: { includeRequested?: boolean } = {},
): Promise<
  Array<{
    user_id: string;
    role: string;
    status: string;
    joined_at: string;
    alias: string | null;
  }>
> {
  const { data, error } = await supabase.rpc("community_roster", {
    p_community_id: communityId,
    p_include_requested: options.includeRequested ?? false,
  });

  if (error) {
    throw new Error(`member list failed: ${error.message}`);
  }

  return ((data ?? []) as Array<{
    user_id: string;
    role: string;
    status: string;
    joined_at: string;
    alias: string | null;
  }>).map((row) => ({
    user_id: row.user_id,
    role: row.role,
    status: row.status,
    joined_at: row.joined_at,
    alias: row.alias ?? null,
  }));
}

/** Channels ordered for the workspace sidebar. */
export async function listCommunityChannels(
  supabase: SupabaseClient,
  communityId: string,
): Promise<CommunityChannelRow[]> {
  const { data, error } = await supabase
    .from("community_channels")
    .select("*")
    .eq("community_id", communityId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    throw new Error(`channel list failed: ${error.message}`);
  }
  return (data ?? []) as CommunityChannelRow[];
}

export async function getCommunityChannel(
  supabase: SupabaseClient,
  communityId: string,
  channelId: string,
): Promise<CommunityChannelRow> {
  const { data, error } = await supabase
    .from("community_channels")
    .select("*")
    .eq("id", channelId)
    .eq("community_id", communityId)
    .maybeSingle();

  if (error) {
    throw new Error(`channel lookup failed: ${error.message}`);
  }
  if (!data) {
    throw notFound("That channel does not exist.");
  }
  return data as CommunityChannelRow;
}

/**
 * Create a community with its owner row and default channel via the
 * `create_community` RPC, then return the fresh row. Identity and role are
 * pinned inside the RPC to `auth.uid()`.
 */
export async function createCommunity(
  supabase: SupabaseClient,
  input: {
    slug: string;
    name: string;
    description: string;
    category: string;
    visibility: string;
    joinPolicy: string;
    rules: string;
  },
): Promise<CommunityRow> {
  const { data, error } = await supabase.rpc("create_community", {
    p_name: input.name,
    p_slug: input.slug,
    p_description: input.description,
    p_category: input.category,
    p_visibility: input.visibility,
    p_join_policy: input.joinPolicy,
    p_rules: input.rules,
  });

  if (error) {
    if (error.message.includes("duplicate key")) {
      throw new CommunityError(
        "slug_taken",
        "That community slug is already taken. Pick another.",
        409,
      );
    }
    throw new Error(`community create failed: ${error.message}`);
  }

  return getCommunity(supabase, String(data));
}

export async function updateCommunity(
  supabase: SupabaseClient,
  communityId: string,
  patch: Record<string, string>,
): Promise<CommunityRow> {
  const { data, error } = await supabase
    .from("communities")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", communityId)
    .select(COMMUNITY_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.message.includes("duplicate key")) {
      throw new CommunityError(
        "slug_taken",
        "That community slug is already taken. Pick another.",
        409,
      );
    }
    throw new Error(`community update failed: ${error.message}`);
  }
  if (!data) {
    throw notFound();
  }
  return data as CommunityRow;
}

export async function joinCommunity(
  supabase: SupabaseClient,
  communityId: string,
): Promise<"active" | "requested"> {
  const { data, error } = await supabase.rpc("join_community", {
    p_community_id: communityId,
  });

  if (error) {
    if (error.message.includes("community_not_found")) {
      throw notFound();
    }
    if (error.message.includes("banned")) {
      throw new CommunityError(
        "forbidden",
        "You are banned from this community.",
        403,
      );
    }
    throw new Error(`community join failed: ${error.message}`);
  }

  return data === "requested" ? "requested" : "active";
}

export async function leaveCommunity(
  supabase: SupabaseClient,
  communityId: string,
): Promise<void> {
  const { error } = await supabase.rpc("leave_community", {
    p_community_id: communityId,
  });

  if (error) {
    if (error.message.includes("community_not_found")) {
      throw notFound();
    }
    if (error.message.includes("owner_cannot_leave")) {
      throw new CommunityError(
        "owner_cannot_leave",
        "The owner must transfer ownership or delete the community first.",
        409,
      );
    }
    throw new Error(`community leave failed: ${error.message}`);
  }
}

export async function setCommunityMember(
  supabase: SupabaseClient,
  communityId: string,
  userId: string,
  patch: { role?: string | null; status?: string | null },
): Promise<void> {
  const { error } = await supabase.rpc("set_community_member", {
    p_community_id: communityId,
    p_user_id: userId,
    p_role: patch.role ?? null,
    p_status: patch.status ?? null,
  });

  if (error) {
    if (error.message.includes("member_not_found")) {
      throw notFound("That member does not exist in this community.");
    }
    if (error.message.includes("owner_protected")) {
      throw new CommunityError(
        "owner_protected",
        "The owner's role and status cannot be changed.",
        409,
      );
    }
    if (error.message.includes("not_owner")) {
      throw new CommunityError(
        "forbidden",
        "Only the community owner can appoint moderators.",
        403,
      );
    }
    if (error.message.includes("not_staff") || error.message.includes("not_authenticated")) {
      throw new CommunityError(
        "forbidden",
        "Only community owners and moderators can do that.",
        403,
      );
    }
    throw new Error(`member update failed: ${error.message}`);
  }
}

/**
 * Remove a member through the `kick_community_member` RPC. `community_members`
 * holds no UPDATE/DELETE grant for `authenticated`, so removal and the
 * `member_count` decrement exist only inside that SECURITY DEFINER function —
 * a direct PostgREST write cannot promote, unban or delete a membership row.
 */
export async function kickCommunityMember(
  supabase: SupabaseClient,
  communityId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase.rpc("kick_community_member", {
    p_community_id: communityId,
    p_user_id: userId,
  });

  if (error) {
    if (error.message.includes("member_not_found")) {
      throw notFound("That member does not exist in this community.");
    }
    if (error.message.includes("owner_protected")) {
      throw new CommunityError(
        "owner_protected",
        "The owner cannot be removed.",
        409,
      );
    }
    if (error.message.includes("not_staff") || error.message.includes("not_authenticated")) {
      throw new CommunityError(
        "forbidden",
        "Only community owners and moderators can do that.",
        403,
      );
    }
    throw new Error(`member kick failed: ${error.message}`);
  }
}

/**
 * One page of a channel's envelope stream, newest first. The rows carry
 * ciphertext only; the client decrypts after fetch.
 */
export async function listCommunityMessages(
  supabase: SupabaseClient,
  channelId: string,
  options: { before?: number; limit: number },
): Promise<{ messages: CommunityMessageRow[]; has_more: boolean }> {
  let query = supabase
    .from("community_messages")
    .select("*")
    .eq("channel_id", channelId)
    .order("seq", { ascending: false })
    .limit(options.limit + 1);

  if (options.before !== undefined) {
    query = query.lt("seq", options.before);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`message list failed: ${error.message}`);
  }

  const rows = (data ?? []) as CommunityMessageRow[];
  return {
    messages: rows.slice(0, options.limit),
    has_more: rows.length > options.limit,
  };
}

/** Insert one envelope. `clientMsgId` is the idempotency key; a retry of the
 * same send returns the existing row instead of failing. */
export async function appendCommunityMessage(
  supabase: SupabaseClient,
  input: {
    channelId: string;
    communityId: string;
    senderId: string;
    senderDeviceId: string;
    kind: "application" | "commit";
    ciphertext: string;
    clientMsgId: string;
  },
): Promise<CommunityMessageRow> {
  const { data: existing } = await supabase
    .from("community_messages")
    .select("*")
    .eq("channel_id", input.channelId)
    .eq("client_msg_id", input.clientMsgId)
    .maybeSingle();

  if (existing) {
    return existing as CommunityMessageRow;
  }

  const { data, error } = await supabase
    .from("community_messages")
    .insert({
      channel_id: input.channelId,
      community_id: input.communityId,
      sender_id: input.senderId,
      sender_device_id: input.senderDeviceId,
      kind: input.kind,
      ciphertext: input.ciphertext,
      client_msg_id: input.clientMsgId,
    })
    .select("*")
    .single();

  if (error) {
    // A concurrent retry racing the same clientMsgId hits the unique index:
    // treat it as the idempotent success it is.
    if (error.code === "23505") {
      const { data: raced } = await supabase
        .from("community_messages")
        .select("*")
        .eq("channel_id", input.channelId)
        .eq("client_msg_id", input.clientMsgId)
        .maybeSingle();
      if (raced) {
        return raced as CommunityMessageRow;
      }
    }
    throw new CommunityError(
      "message_create_failed",
      "The encrypted message could not be stored. Please try again.",
      500,
    );
  }

  return data as CommunityMessageRow;
}

/** Welcomes the caller's devices have not yet consumed, oldest first. */
export async function listPendingWelcomes(
  supabase: SupabaseClient,
  userId: string,
  options: { channelIds?: string[] } = {},
): Promise<CommunityWelcomeRow[]> {
  let query = supabase
    .from("community_welcomes")
    .select("*")
    .eq("recipient_user_id", userId)
    .order("seq", { ascending: true })
    .limit(200);

  if (options.channelIds && options.channelIds.length > 0) {
    query = query.in("channel_id", options.channelIds);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`welcome list failed: ${error.message}`);
  }
  return (data ?? []) as CommunityWelcomeRow[];
}

export async function appendCommunityWelcome(
  supabase: SupabaseClient,
  input: {
    channelId: string;
    communityId: string;
    recipientUserId: string;
    recipientDeviceId: string;
    senderId: string;
    ciphertext: string;
    ratchetTree: string;
    clientMsgId: string;
  },
): Promise<CommunityWelcomeRow> {
  const { data: existing } = await supabase
    .from("community_welcomes")
    .select("*")
    .eq("channel_id", input.channelId)
    .eq("client_msg_id", input.clientMsgId)
    .maybeSingle();

  if (existing) {
    return existing as CommunityWelcomeRow;
  }

  const { data, error } = await supabase
    .from("community_welcomes")
    .insert({
      channel_id: input.channelId,
      community_id: input.communityId,
      recipient_user_id: input.recipientUserId,
      recipient_device_id: input.recipientDeviceId,
      sender_id: input.senderId,
      ciphertext: input.ciphertext,
      ratchet_tree: input.ratchetTree,
      client_msg_id: input.clientMsgId,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      const { data: raced } = await supabase
        .from("community_welcomes")
        .select("*")
        .eq("channel_id", input.channelId)
        .eq("client_msg_id", input.clientMsgId)
        .maybeSingle();
      if (raced) {
        return raced as CommunityWelcomeRow;
      }
    }
    throw new CommunityError(
      "welcome_create_failed",
      "The encrypted welcome could not be stored. Please try again.",
      500,
    );
  }

  return data as CommunityWelcomeRow;
}

export async function registerCommunityDevice(
  supabase: SupabaseClient,
  userId: string,
  input: {
    deviceId: string;
    keyPackage: string;
    signaturePublicKey: string;
  },
): Promise<CommunityDeviceRow> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("community_devices")
    .upsert(
      {
        user_id: userId,
        device_id: input.deviceId,
        key_package: input.keyPackage,
        signature_public_key: input.signaturePublicKey,
        refreshed_at: now,
      },
      { onConflict: "user_id,device_id" },
    )
    .select("*")
    .single();

  if (error) {
    throw new CommunityError(
      "device_register_failed",
      "The device could not be registered. Please try again.",
      500,
    );
  }
  return data as CommunityDeviceRow;
}

/**
 * Key packages for the given users — at most three freshest per user, enough
 * for one Add commit batch. Packages are public MLS credentials by design.
 */
export async function fetchCommunityKeyPackages(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<CommunityDeviceRow[]> {
  const { data, error } = await supabase
    .from("community_devices")
    .select("*")
    .in("user_id", userIds)
    .order("refreshed_at", { ascending: false })
    .limit(userIds.length * 3);

  if (error) {
    throw new Error(`key package fetch failed: ${error.message}`);
  }
  return (data ?? []) as CommunityDeviceRow[];
}

/** Active members of a community minus the caller — the Add-commit targets. */
export async function listActiveMemberIds(
  supabase: SupabaseClient,
  communityId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("community_members")
    .select("user_id")
    .eq("community_id", communityId)
    .eq("status", "active")
    .limit(500);

  if (error) {
    throw new Error(`member ids failed: ${error.message}`);
  }
  return ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
}

export async function createCommunityAttachment(
  supabase: SupabaseClient,
  input: {
    communityId: string;
    channelId: string;
    uploaderId: string;
    storagePath: string;
    ciphertextSize: number;
    contentType: string;
  },
): Promise<CommunityAttachmentRow> {
  const { data, error } = await supabase
    .from("community_attachments")
    .insert({
      community_id: input.communityId,
      channel_id: input.channelId,
      uploader_id: input.uploaderId,
      storage_path: input.storagePath,
      ciphertext_size: input.ciphertextSize,
      content_type: input.contentType,
    })
    .select("*")
    .single();

  if (error) {
    throw new CommunityError(
      "attachment_create_failed",
      "The attachment record could not be saved. Please try again.",
      500,
    );
  }
  return data as CommunityAttachmentRow;
}

export async function getCommunityAttachment(
  supabase: SupabaseClient,
  communityId: string,
  attachmentId: string,
): Promise<CommunityAttachmentRow> {
  const { data, error } = await supabase
    .from("community_attachments")
    .select("*")
    .eq("id", attachmentId)
    .eq("community_id", communityId)
    .maybeSingle();

  if (error) {
    throw new Error(`attachment lookup failed: ${error.message}`);
  }
  if (!data) {
    throw notFound("That attachment does not exist.");
  }
  return data as CommunityAttachmentRow;
}

export async function createCommunityReport(
  supabase: SupabaseClient,
  input: {
    communityId: string;
    reporterId: string;
    targetType: "message" | "member";
    targetId: string;
    reason: string;
    contextExcerpt: string | null;
  },
): Promise<CommunityReportRow> {
  const { data, error } = await supabase
    .from("community_reports")
    .insert({
      community_id: input.communityId,
      reporter_id: input.reporterId,
      target_type: input.targetType,
      target_id: input.targetId,
      reason: input.reason,
      context_excerpt: input.contextExcerpt,
    })
    .select("*")
    .single();

  if (error) {
    throw new CommunityError(
      "report_create_failed",
      "The report could not be filed. Please try again.",
      500,
    );
  }
  return data as CommunityReportRow;
}
