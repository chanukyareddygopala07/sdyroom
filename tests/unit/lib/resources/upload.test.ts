import { parseUploadForm } from "@/lib/resources/upload";
import { MAX_FILE_BYTES } from "@/lib/validation/resources";
import { describe, expect, it } from "vitest";

const ROOM = "11111111-1111-4111-8111-111111111111";

function fileOf(name: string, content: Uint8Array | string, type?: string): File {
  const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return new File([body as BlobPart], name, type === undefined ? {} : { type });
}

function uploadForm(
  overrides: {
    file?: File | null;
    title?: string;
    subject?: string;
    chapter?: string;
    roomId?: string;
    extra?: Record<string, string>;
    skipFile?: boolean;
  } = {},
): FormData {
  const form = new FormData();
  if (!overrides.skipFile) {
    form.append(
      "file",
      overrides.file ?? fileOf("notes.pdf", "%PDF-1.4\ntrailer"),
    );
  }
  if (overrides.title !== undefined) form.append("title", overrides.title);
  if (overrides.subject !== undefined) form.append("subject", overrides.subject);
  if (overrides.chapter !== undefined) form.append("chapter", overrides.chapter);
  if (overrides.roomId !== undefined) form.append("room_id", overrides.roomId);
  for (const [key, value] of Object.entries(overrides.extra ?? {})) {
    form.append(key, value);
  }
  return form;
}

describe("parseUploadForm", () => {
  it("accepts a personal upload and normalises blank optional lines to null", async () => {
    const parsed = await parseUploadForm(
      uploadForm({ title: "  Rotational motion  ", subject: "   ", chapter: "" }),
    );

    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.metadata).toEqual({
      title: "Rotational motion",
      subject: null,
      chapter: null,
      room_id: undefined,
    });
    expect(parsed.accepted).toEqual({
      kind: "accepted",
      content_type: "application/pdf",
      extension: ".pdf",
    });
    expect(parsed.file.name).toBe("notes.pdf");
  });

  it("keeps a room id when one is supplied", async () => {
    const parsed = await parseUploadForm(
      uploadForm({ title: "Shared notes", roomId: ROOM }),
    );

    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.metadata.room_id).toBe(ROOM);
  });

  it("rejects an unexpected part instead of ignoring it", async () => {
    const parsed = await parseUploadForm(
      uploadForm({ title: "Notes", extra: { owner_id: "someone-else" } }),
    );

    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.code).toBe("invalid_request");
    expect(parsed.status).toBe(400);
    expect(parsed.issues).toEqual([{ path: "owner_id", message: "Not accepted here." }]);
  });

  it("rejects an upload with no file part", async () => {
    const parsed = await parseUploadForm(uploadForm({ skipFile: true }));

    expect(parsed).toMatchObject({ kind: "error", code: "validation", status: 400 });
    if (parsed.kind !== "error") return;
    expect(parsed.issues?.[0]?.path).toBe("file");
  });

  it("rejects a text part that was sent as a file", async () => {
    const form = uploadForm({ title: "Notes" });
    form.set("title", fileOf("title.txt", "Notes"));

    const parsed = await parseUploadForm(form);

    expect(parsed).toMatchObject({ kind: "error", code: "invalid_request", status: 400 });
    if (parsed.kind !== "error") return;
    expect(parsed.issues).toEqual([
      { path: "title", message: "Expected text for this field." },
    ]);
  });

  it("rejects a missing title", async () => {
    const parsed = await parseUploadForm(uploadForm({}));

    expect(parsed).toMatchObject({ kind: "error", code: "validation", status: 400 });
    if (parsed.kind !== "error") return;
    expect(parsed.issues?.[0]?.path).toBe("title");
  });

  it("rejects a room id that is not a UUID", async () => {
    const parsed = await parseUploadForm(
      uploadForm({ title: "Notes", roomId: "not-a-uuid" }),
    );

    expect(parsed).toMatchObject({ kind: "error", code: "validation", status: 400 });
    if (parsed.kind !== "error") return;
    expect(parsed.issues?.[0]?.path).toBe("room_id");
  });

  it("refuses an oversized file with 413 before reading its bytes", async () => {
    const oversized = fileOf(
      "big.pdf",
      new Uint8Array(MAX_FILE_BYTES + 1),
      "application/pdf",
    );

    const parsed = await parseUploadForm(uploadForm({ title: "Notes", file: oversized }));

    expect(parsed).toMatchObject({
      kind: "error",
      code: "file_too_large",
      status: 413,
    });
  });

  it("carries a file-type rejection through with its status", async () => {
    const parsed = await parseUploadForm(
      uploadForm({ title: "Notes", file: fileOf("setup.exe", "MZ") }),
    );

    expect(parsed).toMatchObject({
      kind: "error",
      code: "unsupported_file_type",
      status: 415,
    });
  });
});
