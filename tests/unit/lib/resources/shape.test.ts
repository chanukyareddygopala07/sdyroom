import { toStudyResource } from "@/lib/resources/shape";
import { STUDY_RESOURCE_COLUMNS } from "@/lib/resources/types";
import { describe, expect, it } from "vitest";

const ROW = {
  id: "44444444-4444-4444-8444-444444444444",
  title: "Rotational motion",
  original_filename: "rotational.pdf",
  content_type: "application/pdf",
  size_bytes: 2048,
  subject: "Physics",
  chapter: "Chapter 4",
  room_id: null,
  created_at: "2026-10-06T07:00:00+00:00",
  updated_at: "2026-10-06T07:00:00+00:00",
  owner_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storage_path: "personal/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/4444.pdf",
};

describe("toStudyResource", () => {
  it("keeps the exposed fields and drops owner_id and storage_path", () => {
    const resource = toStudyResource(ROW);

    expect(resource).toEqual({
      id: ROW.id,
      title: ROW.title,
      original_filename: ROW.original_filename,
      content_type: ROW.content_type,
      size_bytes: ROW.size_bytes,
      subject: ROW.subject,
      chapter: ROW.chapter,
      room_id: null,
      created_at: ROW.created_at,
      updated_at: ROW.updated_at,
    });
    expect(Object.keys(resource)).not.toContain("owner_id");
    expect(Object.keys(resource)).not.toContain("storage_path");
  });

  it("normalises absent optional text to null", () => {
    const resource = toStudyResource({ ...ROW, subject: null, chapter: null });

    expect(resource.subject).toBeNull();
    expect(resource.chapter).toBeNull();
  });

  it.each([
    ["id", 42],
    ["title", 42],
    ["content_type", "application/zip"],
    ["size_bytes", "big"],
    ["size_bytes", -1],
    ["room_id", 42],
    ["created_at", null],
  ])("rejects a row where %s is %j", (field, value) => {
    expect(() => toStudyResource({ ...ROW, [field]: value })).toThrow();
  });

  it("rejects a payload that is not an object", () => {
    expect(() => toStudyResource(null)).toThrow("Missing resource payload.");
    expect(() => toStudyResource([ROW])).toThrow("Missing resource payload.");
  });
});

describe("STUDY_RESOURCE_COLUMNS", () => {
  it("never selects the whole table", () => {
    expect(STUDY_RESOURCE_COLUMNS).not.toContain("*");
    expect(STUDY_RESOURCE_COLUMNS).not.toContain("owner_id");
    expect(STUDY_RESOURCE_COLUMNS).not.toContain("storage_path");
  });
});
