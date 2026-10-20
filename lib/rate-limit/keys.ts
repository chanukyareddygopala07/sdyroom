/**
 * Rate-limit key naming — the shared contract for every throttled endpoint.
 *
 * A key is `route[:scope]:subject`, where `subject` is always the caller's
 * user id (identity comes from the session, never from the request). Keys are
 * deliberately opaque strings: `rate_limit_take()` only ever sees them, so a
 * new route can adopt the mechanism without a migration.
 *
 * The numbers here are published in `docs/API_CONTRACTS.md` ("Rate limits")
 * and are part of the API contract — change them there too. They are split
 * per concern: an overall per-user ceiling stops one account from doing
 * unbounded work, while a per-target key stops it from concentrating all of
 * that work on one room, report thread or invitation.
 */
export type RateLimitSpec = {
  key: string;
  max: number;
  windowSeconds: number;
};

/** Overall per-user ceiling for uploads, across every room and personal. */
export const UPLOAD_USER_LIMIT = { max: 20, windowSeconds: 60 } as const;

/** Per-target upload ceiling: one room (or the personal library) at a time. */
export const UPLOAD_TARGET_LIMIT = { max: 10, windowSeconds: 60 } as const;

/** Deletions are cheap but destructive; this bounds scripted churn. */
export const RESOURCE_DELETE_LIMIT = { max: 30, windowSeconds: 60 } as const;

/** Signed-URL issuance. Generous: opening files is normal use, not abuse. */
export const DOWNLOAD_LIMIT = { max: 120, windowSeconds: 60 } as const;

/** Orphan sweeps do real work over storage; they are maintenance, not UI. */
export const CLEANUP_LIMIT = { max: 5, windowSeconds: 60 } as const;

/** Report filing — limit per room, per reporter. */
export const REPORT_LIMIT = { max: 20, windowSeconds: 3600 } as const;

/** Block/unblock — a global per-user action, not room-scoped. */
export const BLOCK_LIMIT = { max: 30, windowSeconds: 3600 } as const;

/** Mute/unmute — a per-room moderator action. */
export const MUTE_LIMIT = { max: 30, windowSeconds: 3600 } as const;

/**
 * Profile saves (`PATCH /api/profile`). One save is a single row update;
 * 30/60s bounds a client retry loop or scripted alias churn while sitting
 * far above any human's editing pace. The read path stays unthrottled — it
 * costs one indexed row lookup and the header already reads the same table.
 */
export const PROFILE_LIMIT = { max: 30, windowSeconds: 60 } as const;

/** Invitation creation — limit per room, per inviter. */
export const INVITE_LIMIT = { max: 10, windowSeconds: 3600 } as const;

/**
 * Ingest step calls (`POST /api/ai/ingest/[resourceId]`). Each call runs one
 * bounded step, and a full document needs a handful of calls — 30/60s gives
 * a patient client room for a whole queue while stopping a script from
 * re-driving extract loops against one resource.
 */
export const INGEST_LIMIT = { max: 30, windowSeconds: 60 } as const;

/** Sweep calls — maintenance, not UI; one sweep already advances many rows. */
export const SWEEP_LIMIT = { max: 6, windowSeconds: 60 } as const;

/**
 * Ask calls (`POST /api/rooms/[id]/ask`). One question is one full RAG pass
 * (embed + retrieve + complete); 20/60s per room bounds a scripted question
 * loop while leaving a patient study session untouched.
 */
export const ASK_LIMIT = { max: 20, windowSeconds: 60 } as const;

/**
 * Generation calls (`POST /api/rooms/[id]/generate` and its `.../step`).
 * One quiz or deck is two requests (create + one bounded step) and spends a
 * full provider completion; 10/60s per room bounds a scripted generation
 * loop while leaving a patient build session untouched.
 */
export const GENERATE_LIMIT = { max: 10, windowSeconds: 60 } as const;

/**
 * Study-plan calls (`POST /api/plans` and its `.../step`). A plan is two
 * requests (create + one bounded step) and spends a full provider
 * completion; 10/60s bounds a scripted plan loop while leaving a patient
 * build session untouched. Keyed per plan scope (room or `personal`) per
 * user, so one room's plan traffic cannot starve another scope.
 */
export const PLAN_LIMIT = { max: 10, windowSeconds: 60 } as const;

/**
 * Chat sends (`POST /api/rooms/[id]/messages`). Keyed per room, per
 * sender: 30/60s bounds a scripted flood of one room while sitting far
 * above any human's typing pace, and a second room's allowance is
 * untouched.
 */
export const MESSAGE_LIMIT = { max: 30, windowSeconds: 60 } as const;

/**
 * Room creation (`POST /api/rooms`). Creating a room runs the `create_room`
 * RPC with membership bookkeeping; 5/60s per account bounds scripted room
 * churn while a real organizer never comes close.
 */
export const ROOM_CREATE_LIMIT = { max: 5, windowSeconds: 60 } as const;

/**
 * Meeting-token minting (`POST /api/rooms/[id]/meeting/token`). A token is a
 * short-lived join credential, so the window exists to bound scripted
 * minting (mirroring `DOWNLOAD_LIMIT`'s reasoning) while sitting well above
 * an honest reconnect loop: 12/60s per room, per user leaves every other
 * room's allowance untouched.
 */
export const MEETING_TOKEN_LIMIT = { max: 12, windowSeconds: 60 } as const;

/**
 * Notification preference saves (`PATCH /api/profile/notification-prefs`).
 * A merged row update, mirroring PROFILE_LIMIT: 30/60s bounds a client
 * retry loop while sitting far above any human's toggling pace.
 */
export const NOTIFICATION_PREFS_LIMIT = { max: 30, windowSeconds: 60 } as const;

export function uploadUserKey(userId: string): string {
  return `upload:user:${userId}`;
}

/** `roomId` is the literal `personal` for the private library. */
export function uploadTargetKey(userId: string, roomId: string | null): string {
  return `upload:${roomId ?? "personal"}:${userId}`;
}

export function resourceDeleteKey(userId: string): string {
  return `resource_delete:user:${userId}`;
}

export function downloadKey(userId: string): string {
  return `download:user:${userId}`;
}

export function cleanupKey(userId: string): string {
  return `cleanup:user:${userId}`;
}

export function reportKey(roomId: string, userId: string): string {
  return `report:${roomId}:${userId}`;
}

export function blockKey(userId: string): string {
  return `block:user:${userId}`;
}

export function muteKey(roomId: string, userId: string): string {
  return `mute:${roomId}:${userId}`;
}

export function inviteKey(roomId: string, userId: string): string {
  return `invite:${roomId}:${userId}`;
}

/** Spec + key together, so a call site is one argument. */
export function uploadUserSpec(userId: string): RateLimitSpec {
  return { key: uploadUserKey(userId), ...UPLOAD_USER_LIMIT };
}

export function uploadTargetSpec(userId: string, roomId: string | null): RateLimitSpec {
  return { key: uploadTargetKey(userId, roomId), ...UPLOAD_TARGET_LIMIT };
}

export function resourceDeleteSpec(userId: string): RateLimitSpec {
  return { key: resourceDeleteKey(userId), ...RESOURCE_DELETE_LIMIT };
}

export function downloadSpec(userId: string): RateLimitSpec {
  return { key: downloadKey(userId), ...DOWNLOAD_LIMIT };
}

export function cleanupSpec(userId: string): RateLimitSpec {
  return { key: cleanupKey(userId), ...CLEANUP_LIMIT };
}

export function reportSpec(roomId: string, userId: string): RateLimitSpec {
  return { key: reportKey(roomId, userId), ...REPORT_LIMIT };
}

export function blockSpec(userId: string): RateLimitSpec {
  return { key: blockKey(userId), ...BLOCK_LIMIT };
}

export function muteSpec(roomId: string, userId: string): RateLimitSpec {
  return { key: muteKey(roomId, userId), ...MUTE_LIMIT };
}

export function inviteSpec(roomId: string, userId: string): RateLimitSpec {
  return { key: inviteKey(roomId, userId), ...INVITE_LIMIT };
}

export function profileKey(userId: string): string {
  return `profile:${userId}`;
}

export function profileSpec(userId: string): RateLimitSpec {
  return { key: profileKey(userId), ...PROFILE_LIMIT };
}

export function ingestKey(userId: string): string {
  return `ingest:user:${userId}`;
}

export function sweepKey(userId: string): string {
  return `sweep:user:${userId}`;
}

export function ingestSpec(userId: string): RateLimitSpec {
  return { key: ingestKey(userId), ...INGEST_LIMIT };
}

export function sweepSpec(userId: string): RateLimitSpec {
  return { key: sweepKey(userId), ...SWEEP_LIMIT };
}

export function askKey(roomId: string, userId: string): string {
  return `ask:${roomId}:${userId}`;
}

export function askSpec(roomId: string, userId: string): RateLimitSpec {
  return { key: askKey(roomId, userId), ...ASK_LIMIT };
}

export function generateKey(roomId: string, userId: string): string {
  return `generate:${roomId}:${userId}`;
}

export function generateSpec(roomId: string, userId: string): RateLimitSpec {
  return { key: generateKey(roomId, userId), ...GENERATE_LIMIT };
}

/** `roomId` is the literal `personal` for a plan outside any room. */
export function planKey(roomId: string | null, userId: string): string {
  return `plan:${roomId ?? "personal"}:${userId}`;
}

export function planSpec(roomId: string | null, userId: string): RateLimitSpec {
  return { key: planKey(roomId, userId), ...PLAN_LIMIT };
}

export function messageKey(roomId: string, userId: string): string {
  return `message:${roomId}:${userId}`;
}

export function messageSpec(roomId: string, userId: string): RateLimitSpec {
  return { key: messageKey(roomId, userId), ...MESSAGE_LIMIT };
}

export function roomCreateKey(userId: string): string {
  return `room_create:user:${userId}`;
}

export function roomCreateSpec(userId: string): RateLimitSpec {
  return { key: roomCreateKey(userId), ...ROOM_CREATE_LIMIT };
}

export function notificationPrefsKey(userId: string): string {
  return `notification_prefs:${userId}`;
}

export function notificationPrefsSpec(userId: string): RateLimitSpec {
  return { key: notificationPrefsKey(userId), ...NOTIFICATION_PREFS_LIMIT };
}

export function meetingTokenKey(roomId: string, userId: string): string {
  return `meeting_token:${roomId}:${userId}`;
}

export function meetingTokenSpec(roomId: string, userId: string): RateLimitSpec {
  return { key: meetingTokenKey(roomId, userId), ...MEETING_TOKEN_LIMIT };
}
