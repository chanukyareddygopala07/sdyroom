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
 * Issues a short-lived signed URL after authorization has already been
 * re-checked for this call.
 *
 * The Storage API re-applies its own RLS at this point, so a URL is only ever
 * produced for an object the caller's policy allows them to read — a second,
 * independent enforcement of the same decision. An expired or unauthorized
 * token reaches the storage service as a 403 at fetch time, never as a
 * permanent link.
 */
export async function createResourceDownloadUrl(
  client: SupabaseClient,
  storagePath: string,
  expiresInSeconds: number = DOWNLOAD_TTL_SECONDS,
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

  return {
    url: absoluteUrl(data.signedUrl),
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
