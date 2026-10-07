import { RESOURCE_CONTENT_TYPES, type StudyResource } from "./types";

function envelopeOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Unexpected resource payload: ${field} is not a string.`);
  }
  return value;
}

/**
 * Parses a raw `study_resources` row onto the exposed view shape, or throws on
 * malformed data.
 *
 * Every producer — a list page, the upload confirmation, a download
 * resolution — runs through here, so a column that is later added to the table
 * cannot reach a client by accident: only the listed fields survive, and
 * `owner_id` / `storage_path` are never read.
 */
export function toStudyResource(value: unknown): StudyResource {
  const row = envelopeOf(value);
  if (!row) {
    throw new Error("Missing resource payload.");
  }

  const id = row.id;
  const title = row.title;
  const originalFilename = row.original_filename;
  const contentType = row.content_type;
  const sizeBytes = row.size_bytes;
  const roomId = row.room_id;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;

  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof originalFilename !== "string" ||
    typeof contentType !== "string" ||
    !(RESOURCE_CONTENT_TYPES as readonly string[]).includes(contentType) ||
    typeof sizeBytes !== "number" ||
    !Number.isInteger(sizeBytes) ||
    sizeBytes < 0 ||
    (roomId !== null && typeof roomId !== "string") ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    throw new Error(
      `Unexpected resource payload: ${JSON.stringify(value).slice(0, 200)}`,
    );
  }

  return {
    id,
    title,
    original_filename: originalFilename,
    content_type: contentType as StudyResource["content_type"],
    size_bytes: sizeBytes,
    subject: optionalText(row.subject, "subject"),
    chapter: optionalText(row.chapter, "chapter"),
    room_id: roomId,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}
