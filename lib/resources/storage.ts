import type { SupabaseClient } from "@supabase/supabase-js";
import { DOWNLOAD_TTL_SECONDS } from "@/lib/validation/resources";
import { ResourceError } from "./queries";
import { RESOURCE_BUCKET } from "./types";

export type StorageScope =
  | { kind: "personal"; ownerId: string }
  | { kind: "room"; roomId: string; ownerId: string };

/**
 * Builds the object key from trusted values only.
 *
 * The layout is the contract the Storage RLS policies read:
 *
 *     personal/{owner}/{resource}{ext}
 *     rooms/{room}/{owner}/{resource}{ext}
 *
 * `resource` is a UUID minted server-side and `{owner}` comes from the verified
 * session, so no part of the key can be influenced by the request. Encoding
 * scope and membership in the path is what lets `storage.objects` policies
 * answer "may this caller read this object?" without a lookup, and it is why a
 * direct Storage API call is subject to the same rules as the app.
 */
export function buildStoragePath(
  scope: StorageScope,
  resourceId: string,
  extension: string,
): string {
  if (scope.kind === "personal") {
    return `personal/${scope.ownerId}/${resourceId}${extension}`;
  }
  return `rooms/${scope.roomId}/${scope.ownerId}/${resourceId}${extension}`;
}

/**
 * True when the object key names `userId` as its uploader.
 *
 * The key layout is fixed by the `study_resources_storage_path_layout` CHECK
 * and written only by this server, so segment 1 (personal) or segment 2
 * (rooms) is always the uploader. The API uses this to decide whether it may
 * attempt a storage mutation *before* making one: a room member who is not the
 * uploader must never even reach the DELETE call, rather than relying on the
 * storage policy to no-op silently. The row-level RLS delete remains the
 * authority for the metadata row itself — this only stops a pointless, and in
 * principle dangerous, write from being issued.
 */
export function isOwnedBy(storagePath: string, userId: string): boolean {
  const segments = storagePath.split("/");
  if (segments[0] === "personal") {
    return segments[1] === userId;
  }
  if (segments[0] === "rooms") {
    return segments[2] === userId;
  }
  return false;
}

/** Reads only what is safe to log; never returned to a client. */
function describe(error: { message?: string } | null): string {
  return error?.message ?? "unknown storage error";
}

/**
 * Uploads the bytes to the private bucket.
 *
 * `upsert: false` matters: a path collision would otherwise silently overwrite
 * an existing object, and paths are UUID-based so a collision means something
 * is wrong rather than something to heal.
 */
export async function uploadResourceObject(
  client: SupabaseClient,
  storagePath: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const { error } = await client.storage.from(RESOURCE_BUCKET).upload(
    storagePath,
    Buffer.from(bytes),
    { contentType, upsert: false },
  );

  if (error) {
    console.error(
      "[resources/storage] upload failed:",
      storagePath.split("/")[0],
      describe(error),
    );
    throw new ResourceError(
      "storage_upload_failed",
      "The file could not be saved. Please try again.",
      500,
    );
  }
}

/**
 * Removes an object. Storage deletion is idempotent: removing a path that is
 * already gone succeeds, which is what makes a retried DELETE converge instead
 * of failing forever after a partial failure.
 */
export async function removeResourceObject(
  client: SupabaseClient,
  storagePath: string,
): Promise<void> {
  const { error } = await client.storage.from(RESOURCE_BUCKET).remove([
    storagePath,
  ]);

  if (error) {
    console.error(
      "[resources/storage] remove failed:",
      storagePath.split("/")[0],
      describe(error),
    );
    throw new ResourceError(
      "cleanup_failed",
      "The file could not be removed. Please try again.",
      500,
    );
  }
}

/**
 * Removes every object under a room's folder — `rooms/{roomId}/**` — before
 * the room's rows are deleted.
 *
 * The sweep lists storage instead of reading `study_resources` paths because
 * the folder *is* the complete universe of room-scoped objects (the
 * `study_resources_storage_path_layout` CHECK pins every room row's key
 * inside this prefix, and personal files live elsewhere), and because listing
 * runs under the caller's own storage RLS: the owner is a member of their
 * room, so every key is visible to them. The room's objects may have been
 * uploaded by any member — which is why 0008 accompanies this with the
 * room-owner DELETE policy on `storage.objects`; without it, the owner could
 * read a member's key but not remove it.
 *
 * An empty room lists nothing and is a no-op. A partial sweep (some removals
 * committed, some failed) is safe to re-run: `remove` on an already-gone key
 * succeeds, so the route's retry converges while the room row still exists.
 */
export async function removeRoomStorageObjects(
  client: SupabaseClient,
  roomId: string,
): Promise<void> {
  const bucket = client.storage.from(RESOURCE_BUCKET);
  const prefix = `rooms/${roomId}`;

  const { data: entries, error: listError } = await bucket.list(prefix, {
    limit: 1000,
  });

  if (listError) {
    console.error(
      "[resources/storage] room sweep list failed:",
      describe(listError),
    );
    throw new ResourceError(
      "cleanup_failed",
      "The room's files could not be removed. Please try again.",
      500,
    );
  }

  const paths: string[] = [];
  for (const entry of entries ?? []) {
    // `id === null` marks a folder in the Storage API. The layout is exactly
    // rooms/{room}/{uploader}/{file}, so files sit one level down; anything
    // deeper cannot exist (the CHECK forbids it) and is skipped rather than
    // trusted.
    if (entry.id !== null) {
      continue;
    }
    const folderPath = `${prefix}/${entry.name}`;
    const { data: files, error: folderError } = await bucket.list(folderPath, {
      limit: 1000,
    });
    if (folderError) {
      console.error(
        "[resources/storage] room sweep list failed:",
        describe(folderError),
      );
      throw new ResourceError(
        "cleanup_failed",
        "The room's files could not be removed. Please try again.",
        500,
      );
    }
    for (const file of files ?? []) {
      if (file.id !== null) {
        paths.push(`${folderPath}/${file.name}`);
      }
    }
  }

  // Chunked so one room with many files never turns into a single oversized
  // request; a failure after a chunk committed still converges on retry.
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await bucket.remove(paths.slice(i, i + 100));
    if (error) {
      console.error(
        "[resources/storage] room sweep remove failed:",
        paths.length - i,
        "keys remaining,",
        describe(error),
      );
      throw new ResourceError(
        "cleanup_failed",
        "The room's files could not be removed. Please try again.",
        500,
      );
    }
  }
}

/**
 * Issues a short-lived signed URL after authorization has already been
 * re-checked for this call.
 *
 * The Storage API re-applies its own RLS at this point, so a URL is only ever
 * produced for an object the caller's policy allows them to read — a second,
 * independent enforcement of the same decision. An expired or unauthorized
 * token reaches the storage service as a 403 at fetch time, never as a
 * permanent link.
 *
 * A `download` query parameter is appended with the caller's original file
 * name so the storage service answers with
 * `Content-Disposition: attachment` — files in this app are downloaded, never
 * rendered inline from the storage origin (which serves them without
 * `X-Content-Type-Options`). The parameter is added after signing, exactly as
 * the storage client itself does, and is encoded once here because the
 * client's own `encodeURI` pass would double-encode a percent sign.
 */
export async function createResourceDownloadUrl(
  client: SupabaseClient,
  storagePath: string,
  expiresInSeconds: number = DOWNLOAD_TTL_SECONDS,
  downloadName?: string,
): Promise<{ url: string; expires_in: number }> {
  const { data, error } = await client.storage
    .from(RESOURCE_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new ResourceError(
      "download_failed",
      "This file could not be opened. Please try again.",
      500,
    );
  }

  const url = absoluteUrl(data.signedUrl);
  return {
    url: downloadName
      ? `${url}&download=${encodeURIComponent(downloadName)}`
      : url,
    expires_in: expiresInSeconds,
  };
}

/**
 * Storage returns the path relative to its own origin. The browser needs an
 * absolute URL to open, so the configured API origin is prepended — and only
 * the configured origin, never one taken from the request.
 */
function absoluteUrl(signedUrl: string): string {
  if (/^https?:\/\//i.test(signedUrl)) {
    return signedUrl;
  }
  const origin = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!origin) {
    return signedUrl;
  }
  return `${origin.replace(/\/+$/, "")}${signedUrl.startsWith("/") ? "" : "/"}${signedUrl}`;
}
