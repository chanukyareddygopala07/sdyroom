/**
 * Typed client fetchers for the community API. Every function throws
 * `CommunityApiError` carrying the server's `{ error: { code, message } }`
 * envelope so UI code can branch on `code` (rate_limited, not_found, …)
 * without re-inventing parsing. Identity never travels in bodies — the
 * session cookie authenticates every call.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CommunityChannelRow,
  CommunityDeviceRow,
  CommunityMessageRow,
  CommunityRow,
  CommunityWelcomeRow,
} from "@/lib/communities/types";

export class CommunityApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter: number | null;

  constructor(
    code: string,
    message: string,
    status: number,
    retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "CommunityApiError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const envelope = (body as { error?: { code?: string; message?: string } } | null)
      ?.error;
    const retryAfterHeader = response.headers.get("retry-after");
    throw new CommunityApiError(
      envelope?.code ?? "request_failed",
      envelope?.message ?? "Something went wrong. Please try again.",
      response.status,
      retryAfterHeader ? Number(retryAfterHeader) : null,
    );
  }

  return body as T;
}

export type DiscoveryPage = {
  communities: CommunityRow[];
  has_more: boolean;
};

export function listCommunitiesClient(params: {
  category?: string;
  q?: string;
  limit?: number;
}): Promise<DiscoveryPage> {
  const query = new URLSearchParams();
  if (params.category) query.set("category", params.category);
  if (params.q) query.set("q", params.q);
  if (params.limit) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return request<DiscoveryPage>(`/api/communities${suffix ? `?${suffix}` : ""}`);
}

export type CommunityDetail = {
  community: CommunityRow;
  membership: { role: string; status: string; joined_at: string } | null;
  visibility: "public" | "private";
};

export function getCommunityClient(id: string): Promise<CommunityDetail> {
  return request<CommunityDetail>(`/api/communities/${id}`);
}

export function createCommunityClient(body: {
  slug: string;
  name: string;
  description?: string;
  category?: string;
  visibility?: string;
  joinPolicy?: string;
  rules?: string;
}): Promise<{ community: CommunityRow }> {
  return request(`/api/communities`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateCommunityClient(
  id: string,
  body: Record<string, string>,
): Promise<{ community: CommunityRow }> {
  return request(`/api/communities/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteCommunityClient(id: string): Promise<void> {
  return request(`/api/communities/${id}`, { method: "DELETE" });
}

export function joinCommunityClient(
  id: string,
): Promise<{ status: "active" | "requested" }> {
  return request(`/api/communities/${id}/join`, { method: "POST" });
}

export function leaveCommunityClient(id: string): Promise<void> {
  return request(`/api/communities/${id}/leave`, { method: "POST" });
}

export type MemberRow = {
  user_id: string;
  role: string;
  status: string;
  joined_at: string;
  alias: string | null;
};

export function listMembersClient(
  id: string,
  options: { includeRequested?: boolean } = {},
): Promise<{ members: MemberRow[] }> {
  const suffix = options.includeRequested ? "?include_requested=1" : "";
  return request(`/api/communities/${id}/members${suffix}`);
}

export function setMemberClient(
  id: string,
  userId: string,
  body: { role?: string | null; status?: string | null },
): Promise<{ ok: true }> {
  return request(`/api/communities/${id}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function removeMemberClient(id: string, userId: string): Promise<void> {
  return request(`/api/communities/${id}/members/${userId}`, { method: "DELETE" });
}

export function listChannelsClient(
  id: string,
): Promise<{ channels: CommunityChannelRow[] }> {
  return request(`/api/communities/${id}/channels`);
}

export function createChannelClient(
  id: string,
  body: { name: string; slug: string; description?: string },
): Promise<{ channel: CommunityChannelRow }> {
  return request(`/api/communities/${id}/channels`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type MessagePage = {
  messages: CommunityMessageRow[];
  has_more: boolean;
};

export function listMessagesClient(
  communityId: string,
  channelId: string,
  params: { before?: number; limit?: number } = {},
): Promise<MessagePage> {
  const query = new URLSearchParams();
  if (params.before !== undefined) query.set("before", String(params.before));
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return request(
    `/api/communities/${communityId}/channels/${channelId}/messages${suffix ? `?${suffix}` : ""}`,
  );
}

export function sendMessageClient(
  communityId: string,
  channelId: string,
  body: {
    kind: "application" | "commit";
    ciphertext: string;
    clientMsgId: string;
    senderDeviceId: string;
  },
): Promise<{ message: CommunityMessageRow }> {
  return request(
    `/api/communities/${communityId}/channels/${channelId}/messages`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function sendWelcomeClient(
  communityId: string,
  channelId: string,
  body: {
    ciphertext: string;
    ratchetTree: string;
    clientMsgId: string;
    recipientUserId: string;
    recipientDeviceId: string;
  },
): Promise<{ welcome: CommunityWelcomeRow }> {
  return request(
    `/api/communities/${communityId}/channels/${channelId}/welcomes`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function listWelcomesClient(
  communityId: string,
): Promise<{ welcomes: CommunityWelcomeRow[] }> {
  return request(`/api/communities/${communityId}/welcomes`);
}

export function registerDeviceClient(body: {
  deviceId: string;
  keyPackage: string;
  signaturePublicKey: string;
}): Promise<{ device: CommunityDeviceRow }> {
  return request(`/api/communities/devices`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function syncClient(communityId: string): Promise<{
  member_ids: string[];
  devices: CommunityDeviceRow[];
}> {
  return request(`/api/communities/${communityId}/sync`);
}

export function createAttachmentClient(
  communityId: string,
  body: {
    channelId: string;
    storagePath: string;
    ciphertextSize: number;
    contentType: string;
  },
): Promise<{ attachment: { id: string } }> {
  return request(`/api/communities/${communityId}/attachments`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function downloadAttachmentClient(
  communityId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const { url } = await request<{ url: string }>(
    `/api/communities/${communityId}/attachments/${attachmentId}`,
  );
  const response = await fetch(url);
  if (!response.ok) {
    throw new CommunityApiError(
      "attachment_download_failed",
      "The attachment could not be downloaded.",
      response.status,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function reportClient(
  communityId: string,
  body: {
    targetType: "message" | "member";
    targetId: string;
    reason: string;
    contextExcerpt?: string | null;
  },
): Promise<{ report: { id: string } }> {
  return request(`/api/communities/${communityId}/reports`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Upload ciphertext bytes to the private bucket. Storage policy allows
 * member inserts under the community prefix; the browser client uses the
 * Supabase storage API directly with the session. */
export async function uploadAttachmentBytes(
  supabase: SupabaseClient,
  storagePath: string,
  ciphertext: Uint8Array,
): Promise<void> {
  const { error } = await supabase.storage
    .from("community-attachments")
    .upload(storagePath, ciphertext, {
      contentType: "application/octet-stream",
      upsert: false,
    });
  if (error) {
    throw new CommunityApiError(
      "attachment_upload_failed",
      "The attachment upload failed. Please try again.",
      500,
    );
  }
}

export type GifResult = {
  id: string;
  preview_url: string;
  full_url: string;
  width: number;
  height: number;
};

export function gifSearchClient(q: string): Promise<{ gifs: GifResult[] }> {
  return request(`/api/communities/gif/search?q=${encodeURIComponent(q)}`);
}

export async function gifFetchClient(url: string): Promise<Uint8Array> {
  const response = await fetch("/api/communities/gif/fetch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const envelope = (body as { error?: { code?: string; message?: string } } | null)
      ?.error;
    throw new CommunityApiError(
      envelope?.code ?? "gif_provider_failed",
      envelope?.message ?? "The GIF could not be downloaded.",
      response.status,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}
