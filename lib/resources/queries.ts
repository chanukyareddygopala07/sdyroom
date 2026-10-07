import type { SupabaseClient } from "@supabase/supabase-js";
import { toStudyResource } from "./shape";
import { STUDY_RESOURCE_COLUMNS, type StudyResource } from "./types";

export type ResourceErrorCode =
  | "not_found"
  | "resources_failed"
  | "storage_upload_failed"
  | "metadata_failed"
  | "download_failed"
  | "delete_failed"
  | "cleanup_failed";

/** Failure carrying the HTTP status the API layer returns. */
export class ResourceError extends Error {
  readonly code: ResourceErrorCode;
  readonly status: number;

  constructor(code: ResourceErrorCode, message: string, status: number) {
    super(message);
    this.name = "ResourceError";
    this.code = code;
    this.status = status;
  }
}

const NOT_FOUND_MESSAGE = "That resource does not exist or is not available.";

/**
 * Escapes LIKE/ILIKE metacharacters so a search string is matched literally.
 * Without this, a `%` in a student's query would silently turn into a wildcard
 * and return more rows than the query asked for.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export type ListResourcesInput = {
  /** The authenticated viewer; only rows RLS lets them read come back. */
  viewerId: string;
  scope: "personal" | "room";
  /** Required when `scope === "room"`. */
  roomId?: string | undefined;
  q: string;
  subject: string | null;
  chapter: string | null;
  limit: number;
  offset: number;
};

export type ListResourcesResult = {
  resources: StudyResource[];
  limit: number;
  offset: number;
  has_more: boolean;
};

/**
 * One page of resources for a scope, newest first.
 *
 * Scope is expressed as an explicit filter, never as "whatever RLS returns":
 * a personal listing always carries `room_id IS NULL`, so a shared file can
 * never appear in the personal library even though its owner can read it.
 * `has_more` comes from an exact count rather than from a short page, so it
 * cannot report "no more" while rows remain below the window.
 */
export async function listResources(
  client: SupabaseClient,
  input: ListResourcesInput,
): Promise<ListResourcesResult> {
  let query = client
    .from("study_resources")
    .select(STUDY_RESOURCE_COLUMNS, { count: "exact" });

  if (input.scope === "personal") {
    query = query.is("room_id", null);
  } else {
    if (input.roomId === undefined) {
      throw new ResourceError("not_found", NOT_FOUND_MESSAGE, 404);
    }
    query = query.eq("room_id", input.roomId);
  }

  if (input.q !== "") {
    query = query.ilike("title", `%${escapeLike(input.q)}%`);
  }
  if (input.subject !== null) {
    query = query.ilike("subject", escapeLike(input.subject));
  }
  if (input.chapter !== null) {
    query = query.ilike("chapter", escapeLike(input.chapter));
  }

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(input.offset, input.offset + input.limit - 1);

  if (error) {
    throw new Error(`resource list failed: ${error.message}`);
  }

  const rows = data ?? [];
  const resources = rows.map((row) => toStudyResource(row));
  const total = count ?? input.offset + rows.length;

  return {
    resources,
    limit: input.limit,
    offset: input.offset,
    has_more: input.offset + rows.length < total,
  };
}

export type InsertResourceInput = {
  /** UUID minted by the caller, reused as the storage key's object name. */
  id: string;
  roomId: string | null;
  storagePath: string;
  title: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  subject: string | null;
  chapter: string | null;
};

/**
 * Writes the metadata row after the object already exists in storage.
 *
 * `owner_id` is deliberately absent from the insert: the column defaults to
 * `auth.uid()` and has no INSERT grant, so a client cannot choose an owner even
 * in principle — the privilege layer rejects the column before RLS is
 * consulted, and the `with check` policy rejects a mismatching value anyway.
 *
 * Failure mapping: 42501 means RLS refused the row (the caller is no longer a
 * member of the room they were sharing into) and 23503 means the room vanished
 * between the membership check and the write. Both read as the same 404 the
 * rest of the room API gives, so the endpoint never becomes an oracle.
 */
export async function insertResource(
  client: SupabaseClient,
  input: InsertResourceInput,
): Promise<StudyResource> {
  const { data, error } = await client
    .from("study_resources")
    .insert({
      id: input.id,
      room_id: input.roomId,
      storage_path: input.storagePath,
      title: input.title,
      original_filename: input.originalFilename,
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      subject: input.subject,
      chapter: input.chapter,
    })
    .select(STUDY_RESOURCE_COLUMNS)
    .single();

  if (error) {
    if (error.code === "42501" || error.code === "23503") {
      throw new ResourceError("not_found", NOT_FOUND_MESSAGE, 404);
    }
    throw new Error(`resource insert failed: ${error.message}`);
  }

  return toStudyResource(data);
}

/**
 * The columns a download or a deletion needs but a response must never carry.
 * `storage_path` is granted for SELECT so the API can resolve it, and it is
 * stripped again by `toStudyResource` before anything is serialised.
 */
const RESOURCE_LOCATOR_COLUMNS = "id, room_id, storage_path";

export type ResourceLocator = {
  id: string;
  room_id: string | null;
  storage_path: string;
};

/**
 * Resolves one resource for a download or a delete.
 *
 * RLS decides visibility, so a row that is missing and a row the caller may
 * not see both come back as `null` and become the same 404. The returned path
 * is checked against the server-built layout before it is used, so a corrupted
 * or hand-written path can never be turned into a signed URL.
 */
export async function findResourceLocator(
  client: SupabaseClient,
  resourceId: string,
): Promise<ResourceLocator | null> {
  const { data, error } = await client
    .from("study_resources")
    .select(RESOURCE_LOCATOR_COLUMNS)
    .eq("id", resourceId)
    .maybeSingle();

  if (error) {
    throw new Error(`resource lookup failed: ${error.message}`);
  }
  if (!data) {
    return null;
  }

  const storagePath = data.storage_path;
  if (
    typeof storagePath !== "string" ||
    storagePath.startsWith("/") ||
    storagePath.includes("..")
  ) {
    // Corrupt row: the caller must never see the value, and the route that
    // caught this decides which generic 500 code fits its operation.
    throw new Error("resource has an unusable storage path");
  }

  return {
    id: data.id,
    room_id: data.room_id,
    storage_path: storagePath,
  };
}

/**
 * Deletes the metadata row. Returns false when nothing was deleted, which is
 * how "not yours" and "already gone" both surface as a 404 without telling the
 * caller which one applied.
 *
 * RLS `USING (owner_id = auth.uid())` is the actual check; the caller has no
 * way to name another owner, so a delete either matches the caller's own row
 * or matches nothing at all.
 */
export async function deleteResourceMetadata(
  client: SupabaseClient,
  resourceId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("study_resources")
    .delete()
    .eq("id", resourceId)
    .select("id");

  if (error) {
    throw new ResourceError(
      "delete_failed",
      "The resource could not be deleted. Please try again.",
      500,
    );
  }

  return (data ?? []).length > 0;
}
