/**
 * Shared community constants and row shapes. The wire contract for the
 * ciphertext stream lives here because both the API and the client crypto
 * layer need the same ceilings and kind allow-list.
 */

/** Ceiling on a single base64 MLS envelope stored in `ciphertext`. */
export const COMMUNITY_CIPHERTEXT_MAX_LENGTH = 262_144;

/** Ceiling on a published key package (base64). */
export const COMMUNITY_KEY_PACKAGE_MAX_LENGTH = 65_536;

/** Ceiling on an attachment's ciphertext size: 10 MB, matching the bucket. */
export const COMMUNITY_ATTACHMENT_MAX_BYTES = 10_485_760;

/** History page size the workspace requests, and the hard ceiling on `limit`. */
export const COMMUNITY_MESSAGE_PAGE_SIZE_DEFAULT = 50;
export const COMMUNITY_MESSAGE_PAGE_SIZE_MAX = 100;

export type CommunityRole = "owner" | "moderator" | "member";
export type CommunityMemberStatus = "active" | "requested" | "banned";
export type CommunityVisibility = "public" | "private";
export type CommunityJoinPolicy = "open" | "request";
export type CommunityCategory =
  | "study"
  | "exams"
  | "subjects"
  | "projects"
  | "campus"
  | "other";

/** Kinds of MLS envelopes the message stream accepts. */
export type CommunityMessageKind = "application" | "commit";

export type CommunityRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: CommunityCategory;
  visibility: CommunityVisibility;
  join_policy: CommunityJoinPolicy;
  rules: string;
  owner_id: string;
  member_count: number;
  created_at: string;
  updated_at: string;
};

export type CommunityMemberRow = {
  community_id: string;
  user_id: string;
  role: CommunityRole;
  status: CommunityMemberStatus;
  joined_at: string;
  updated_at: string;
};

export type CommunityChannelRow = {
  id: string;
  community_id: string;
  name: string;
  slug: string;
  description: string;
  position: number;
  created_at: string;
};

export type CommunityMessageRow = {
  id: string;
  channel_id: string;
  community_id: string;
  sender_id: string;
  sender_device_id: string;
  kind: CommunityMessageKind;
  ciphertext: string;
  client_msg_id: string;
  seq: number;
  created_at: string;
};

export type CommunityWelcomeRow = {
  id: string;
  channel_id: string;
  community_id: string;
  recipient_user_id: string;
  recipient_device_id: string;
  sender_id: string;
  ciphertext: string;
  ratchet_tree: string;
  client_msg_id: string;
  seq: number;
  created_at: string;
};

export type CommunityDeviceRow = {
  user_id: string;
  device_id: string;
  key_package: string;
  signature_public_key: string;
  created_at: string;
  refreshed_at: string;
};

export type CommunityAttachmentRow = {
  id: string;
  community_id: string;
  channel_id: string;
  uploader_id: string;
  storage_path: string;
  ciphertext_size: number;
  content_type: string;
  created_at: string;
};

export type CommunityReportRow = {
  id: string;
  community_id: string;
  reporter_id: string;
  target_type: "message" | "member";
  target_id: string;
  reason: string;
  context_excerpt: string | null;
  created_at: string;
};
