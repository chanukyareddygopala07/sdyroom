import {
  MAX_FILENAME_CHARS,
  MAX_FILE_BYTES,
} from "@/lib/validation/resources";
import { RESOURCE_EXTENSIONS, type ResourceContentType } from "./types";

/** Storage suffix chosen from the *verified* type, never from the input name. */
export const CANONICAL_EXTENSION: Record<ResourceContentType, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "text/plain": ".txt",
  "text/markdown": ".md",
};

/**
 * Rejection returned by the validators. It carries the HTTP status the API
 * layer uses, so a rule is stated exactly once and cannot drift between the
 * check and the response.
 */
export type FileRejection = {
  kind: "rejection";
  code:
    | "empty_file"
    | "file_too_large"
    | "invalid_filename"
    | "unsupported_file_type"
    | "malformed_file";
  message: string;
  status: 400 | 413 | 415;
};

export type AcceptedFile = {
  kind: "accepted";
  content_type: ResourceContentType;
  extension: string;
};

export function isFileRejection(value: unknown): value is FileRejection {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "rejection"
  );
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function reject(
  code: FileRejection["code"],
  message: string,
  status: FileRejection["status"],
): FileRejection {
  return { kind: "rejection", code, message, status };
}

/**
 * The file name as it will be *displayed* and, after canonicalisation, as it
 * influences the storage suffix.
 *
 * Path manipulation is rejected rather than sanitised: `/`, `\`, `.` and `..`
 * are never part of a legitimate upload name, and quietly stripping them would
 * hide an attempt that deserves a visible error. The storage key is built from
 * a server-generated UUID anyway, so this check protects the *display* surface.
 */
export function validateFilename(name: string): FileRejection | null {
  const trimmed = name.trim();
  if (trimmed === "") {
    return reject("invalid_filename", "The file needs a name.", 400);
  }
  if (trimmed.length > MAX_FILENAME_CHARS) {
    return reject(
      "invalid_filename",
      `The file name must be ${MAX_FILENAME_CHARS} characters or fewer.`,
      400,
    );
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return reject(
      "invalid_filename",
      "The file name must not contain path separators.",
      400,
    );
  }
  if (trimmed === "." || trimmed === "..") {
    return reject(
      "invalid_filename",
      "That file name is not valid.",
      400,
    );
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return reject(
      "invalid_filename",
      "The file name must not contain control characters.",
      400,
    );
  }
  return null;
}

export function validateFileSize(size: number): FileRejection | null {
  if (!Number.isFinite(size) || size < 0) {
    return reject("malformed_file", "That file size is not valid.", 400);
  }
  if (size === 0) {
    return reject("empty_file", "That file is empty.", 400);
  }
  if (size > MAX_FILE_BYTES) {
    return reject(
      "file_too_large",
      `Files must be ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MiB or smaller.`,
      413,
    );
  }
  return null;
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.length < offset + value.length) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[index] === byte);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

/**
 * The content type implied by the bytes themselves.
 *
 * PDF is searched within the first 1024 bytes because the specification allows
 * leading junk before the header; PNG and JPEG are exact prefix matches. A
 * `null` means "no binary signature this app understands", which for a binary
 * extension is a rejection.
 */
export function detectBinarySignature(
  bytes: Uint8Array,
): ResourceContentType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return "image/png";
  }
  if (startsWith(bytes, JPEG_SIGNATURE)) {
    return "image/jpeg";
  }
  const windowLength = Math.min(bytes.length, 1024);
  for (let index = 0; index + 5 <= windowLength; index += 1) {
    if (asciiAt(bytes, index, "%PDF-")) {
      return "application/pdf";
    }
  }
  return null;
}

/**
 * Text files must be valid UTF-8 and free of NUL and other C0 controls
 * (tab, newline and carriage return excepted). A `.txt` that is really a
 * binary blob is malformed content, not a note.
 */
export function validateTextContent(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "That file is not valid UTF-8 text.";
  }
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      return "That file contains control characters and is not plain text.";
    }
  }
  return null;
}

function extensionOf(name: string): string {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) {
    return "";
  }
  return trimmed.slice(dot).toLowerCase();
}

/**
 * Whether the file name is one this app could possibly accept.
 *
 * The upload form calls this before sending, so an obvious `.exe` gets an
 * instant message instead of a round trip — the server still runs the full
 * `inspectFile` check, which is what actually decides. One allow list
 * (`RESOURCE_EXTENSIONS`) drives both, so the two can never disagree.
 */
export function isSupportedUploadName(name: string): boolean {
  return RESOURCE_EXTENSIONS[extensionOf(name)] !== undefined;
}

/**
 * Full validation of one uploaded file: name, size, extension, signature and
 * — for text — encoding. The returned content type is always derived from the
 * bytes, so a browser-supplied MIME type can never widen what storage accepts.
 *
 * This is format validation only. No malware scanner runs in this project and
 * none is claimed.
 */
export function inspectFile(
  name: string,
  bytes: Uint8Array,
): AcceptedFile | FileRejection {
  const nameRejection = validateFilename(name);
  if (nameRejection) {
    return nameRejection;
  }
  const sizeRejection = validateFileSize(bytes.length);
  if (sizeRejection) {
    return sizeRejection;
  }

  const extension = extensionOf(name);
  const declared =
    extension === "" ? undefined : RESOURCE_EXTENSIONS[extension];
  if (!declared) {
    return reject(
      "unsupported_file_type",
      "Only PDF, PNG, JPEG, TXT and Markdown files can be uploaded.",
      415,
    );
  }

  const detected = detectBinarySignature(bytes);

  if (declared === "text/plain" || declared === "text/markdown") {
    if (detected !== null) {
      return reject(
        "malformed_file",
        "That file's contents do not match its extension.",
        400,
      );
    }
    const textProblem = validateTextContent(bytes);
    if (textProblem !== null) {
      return reject("malformed_file", textProblem, 400);
    }
    return { kind: "accepted", content_type: declared, extension: CANONICAL_EXTENSION[declared] };
  }

  if (detected === null) {
    return reject(
      "malformed_file",
      "That file does not look like a valid document or image.",
      400,
    );
  }
  if (detected !== declared) {
    return reject(
      "malformed_file",
      "That file's contents do not match its extension.",
      400,
    );
  }
  return { kind: "accepted", content_type: declared, extension: CANONICAL_EXTENSION[declared] };
}

/** Human-readable size for list rows. Binary units, one decimal above KiB. */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) {
    return "—";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ["KiB", "MiB", "GiB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}
