import type { ApiIssue } from "@/lib/api/responses";
import { resourceMetadataSchema } from "@/lib/validation/resources";
import {
  inspectFile,
  isFileRejection,
  validateFileSize,
  type AcceptedFile,
} from "./files";

/**
 * The multipart parts `POST /api/resources` accepts. Anything else — including
 * an attempted `owner_id`, `user_id`, `storage_path` or `content_type` — is a
 * rejection rather than a field to ignore.
 */
export const UPLOAD_PARTS = ["file", "title", "subject", "chapter", "room_id"] as const;

export type ParsedUpload = {
  kind: "ok";
  file: { name: string; bytes: Uint8Array };
  accepted: AcceptedFile;
  metadata: {
    title: string;
    subject: string | null;
    chapter: string | null;
    room_id: string | undefined;
  };
};

export type RejectedUpload = {
  kind: "error";
  code: string;
  message: string;
  status: number;
  issues?: ApiIssue[];
};

function fail(
  code: string,
  message: string,
  status: number,
  issues?: ApiIssue[],
): RejectedUpload {
  return { kind: "error", code, message, status, ...(issues ? { issues } : {}) };
}

function isFileEntry(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as File).arrayBuffer === "function"
  );
}

/**
 * Reads a text part, rejecting a `File` that was posted in its place rather
 * than coercing it to `"[object File]"` and storing nonsense.
 */
function readText(
  form: FormData,
  key: string,
): { ok: true; value: string | undefined } | { ok: false; issue: ApiIssue } {
  const value = form.get(key);
  if (value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      issue: { path: key, message: "Expected text for this field." },
    };
  }
  return { ok: true, value };
}

/**
 * Validates one `POST /api/resources` multipart body, in the order the
 * contract documents: unknown parts, then metadata, then the file itself.
 *
 * The file's bytes are read here because the signature check needs them, and
 * the caller must not have to decide whether a rejection happened before or
 * after that read. Nothing is uploaded and no database is touched: this is
 * pure validation, so every branch is unit-testable without a stack.
 */
export async function parseUploadForm(
  form: FormData,
): Promise<ParsedUpload | RejectedUpload> {
  const unexpected = [...new Set(form.keys())].filter(
    (key) => !(UPLOAD_PARTS as readonly string[]).includes(key),
  );
  if (unexpected.length > 0) {
    return fail(
      "invalid_request",
      "This upload does not accept those fields.",
      400,
      unexpected.sort().map((field) => ({
        path: field,
        message: "Not accepted here.",
      })),
    );
  }

  const fileEntry = form.get("file");
  if (!isFileEntry(fileEntry)) {
    return fail("validation", "Choose a file to upload.", 400, [
      { path: "file", message: fileEntry === null ? "A file is required." : "Expected an uploaded file." },
    ]);
  }

  const parts: Record<string, string | undefined> = {};
  const issues: ApiIssue[] = [];
  for (const key of ["title", "subject", "chapter", "room_id"] as const) {
    const read = readText(form, key);
    if (!read.ok) {
      issues.push(read.issue);
    } else {
      parts[key] = read.value;
    }
  }
  if (issues.length > 0) {
    return fail(
      "invalid_request",
      "Some fields were not in the expected form.",
      400,
      issues,
    );
  }

  const parsed = resourceMetadataSchema.safeParse({
    ...(parts.title !== undefined ? { title: parts.title } : {}),
    ...(parts.subject !== undefined ? { subject: parts.subject } : {}),
    ...(parts.chapter !== undefined ? { chapter: parts.chapter } : {}),
    ...(parts.room_id !== undefined ? { room_id: parts.room_id } : {}),
  });
  if (!parsed.success) {
    return fail(
      "validation",
      "Check the highlighted fields and try again.",
      400,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }

  // Size is checked before the payload is buffered, so an oversized upload is
  // refused without pulling it into memory.
  const sizeRejection = validateFileSize(fileEntry.size);
  if (sizeRejection) {
    return fail(sizeRejection.code, sizeRejection.message, sizeRejection.status);
  }

  const bytes = new Uint8Array(await fileEntry.arrayBuffer());
  const inspection = inspectFile(fileEntry.name, bytes);
  if (isFileRejection(inspection)) {
    return fail(inspection.code, inspection.message, inspection.status);
  }

  return {
    kind: "ok",
    file: { name: fileEntry.name, bytes },
    accepted: inspection,
    metadata: {
      title: parsed.data.title,
      subject: parsed.data.subject,
      chapter: parsed.data.chapter,
      room_id: parsed.data.room_id,
    },
  };
}
