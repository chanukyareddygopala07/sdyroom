import {
  detectBinarySignature,
  formatBytes,
  inspectFile,
  isFileRejection,
  isSupportedUploadName,
  validateFilename,
  validateFileSize,
  validateTextContent,
} from "@/lib/resources/files";
import { MAX_FILE_BYTES, MAX_FILENAME_CHARS } from "@/lib/validation/resources";
import { describe, expect, it } from "vitest";

const PNG_HEADER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function pdfWithPrefix(prefix: string): Uint8Array {
  const head = bytesOf(prefix);
  const body = bytesOf("%PDF-1.7\ntrailer");
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

describe("validateFilename", () => {
  it("accepts an ordinary upload name", () => {
    expect(validateFilename("Rotational motion notes.pdf")).toBeNull();
  });

  it.each([
    ["", "empty"],
    ["   ", "empty after trimming"],
    [".", "single dot"],
    ["..", "parent directory"],
    ["a/b.txt", "forward slash"],
    ["a\\b.txt", "backslash"],
  ])("rejects %j (%s)", (name) => {
    const rejection = validateFilename(name);
    expect(rejection).not.toBeNull();
    expect(rejection?.code).toBe("invalid_filename");
    expect(rejection?.status).toBe(400);
  });

  it("rejects a name containing a NUL byte", () => {
    expect(validateFilename("a\u0000b.txt")?.code).toBe("invalid_filename");
  });

  it("rejects a name containing a DEL byte", () => {
    expect(validateFilename("a\u007fb.txt")?.code).toBe("invalid_filename");
  });

  it("rejects a name over the documented limit", () => {
    const rejection = validateFilename("x".repeat(MAX_FILENAME_CHARS + 1));
    expect(rejection?.code).toBe("invalid_filename");
    expect(rejection?.message).toContain(String(MAX_FILENAME_CHARS));
  });

  it("accepts a name exactly at the limit", () => {
    expect(validateFilename("x".repeat(MAX_FILENAME_CHARS))).toBeNull();
  });
});

describe("validateFileSize", () => {
  it("accepts a non-empty file inside the ceiling", () => {
    expect(validateFileSize(1)).toBeNull();
    expect(validateFileSize(MAX_FILE_BYTES)).toBeNull();
  });

  it("rejects an empty file with 400", () => {
    expect(validateFileSize(0)).toMatchObject({
      code: "empty_file",
      status: 400,
    });
  });

  it("rejects a file over the ceiling with 413", () => {
    expect(validateFileSize(MAX_FILE_BYTES + 1)).toMatchObject({
      code: "file_too_large",
      status: 413,
    });
  });

  it("rejects a nonsensical size", () => {
    expect(validateFileSize(-1)?.code).toBe("malformed_file");
    expect(validateFileSize(Number.NaN)?.code).toBe("malformed_file");
  });
});

describe("detectBinarySignature", () => {
  it("recognises the PNG prefix", () => {
    expect(detectBinarySignature(PNG_HEADER)).toBe("image/png");
  });

  it("recognises the JPEG prefix", () => {
    expect(detectBinarySignature(JPEG_HEADER)).toBe("image/jpeg");
  });

  it("recognises a PDF header at the start", () => {
    expect(detectBinarySignature(bytesOf("%PDF-1.7\ntrailer"))).toBe(
      "application/pdf",
    );
  });

  it("finds a header the spec allows to be preceded by junk", () => {
    expect(detectBinarySignature(pdfWithPrefix("junk before the header "))).toBe(
      "application/pdf",
    );
  });

  it("stops the search at 1024 bytes", () => {
    const padded = new Uint8Array(2048);
    padded.set(bytesOf("%PDF-"), 1100);
    expect(detectBinarySignature(padded)).toBeNull();
  });

  it("returns null for plain text", () => {
    expect(detectBinarySignature(bytesOf("just some notes"))).toBeNull();
  });
});

describe("validateTextContent", () => {
  it("accepts UTF-8 text carrying tab, newline and carriage return", () => {
    expect(validateTextContent(bytesOf("line one\r\nline\ttwo\n"))).toBeNull();
  });

  it("rejects a NUL byte", () => {
    expect(validateTextContent(bytesOf("a\u0000b"))).toContain(
      "control characters",
    );
  });

  it("rejects invalid UTF-8", () => {
    expect(validateTextContent(new Uint8Array([0xff, 0xfe, 0x41]))).toContain(
      "not valid UTF-8",
    );
  });
});

describe("inspectFile", () => {
  it("accepts a real PDF and reports the verified type", () => {
    expect(inspectFile("notes.pdf", bytesOf("%PDF-1.4\n"))).toEqual({
      kind: "accepted",
      content_type: "application/pdf",
      extension: ".pdf",
    });
  });

  it("canonicalises .jpeg to the .jpg storage suffix", () => {
    expect(inspectFile("scan.jpeg", JPEG_HEADER)).toMatchObject({
      kind: "accepted",
      content_type: "image/jpeg",
      extension: ".jpg",
    });
  });

  it("accepts a Markdown note", () => {
    expect(inspectFile("plan.MD", bytesOf("# plan\n"))).toEqual({
      kind: "accepted",
      content_type: "text/markdown",
      extension: ".md",
    });
  });

  it("refuses an extension outside the closed list with 415", () => {
    expect(inspectFile("setup.exe", PNG_HEADER)).toMatchObject({
      kind: "rejection",
      code: "unsupported_file_type",
      status: 415,
    });
  });

  it("refuses a .pdf whose bytes are not a PDF", () => {
    expect(
      inspectFile("notes.pdf", bytesOf("these are not pdf bytes")),
    ).toMatchObject({ code: "malformed_file", status: 400 });
  });

  it("refuses a .txt that is really a PNG", () => {
    expect(inspectFile("notes.txt", PNG_HEADER)).toMatchObject({
      code: "malformed_file",
    });
  });

  it("refuses a .png that carries text", () => {
    expect(inspectFile("img.png", bytesOf("not an image"))).toMatchObject({
      code: "malformed_file",
    });
  });

  it("refuses a .txt holding a binary blob", () => {
    expect(
      inspectFile("notes.txt", new Uint8Array([0x00, 0x01, 0x02])),
    ).toMatchObject({ code: "malformed_file" });
  });

  it("refuses an oversized file", () => {
    const oversized = new Uint8Array(MAX_FILE_BYTES + 1);
    expect(inspectFile("big.pdf", oversized)).toMatchObject({
      code: "file_too_large",
      status: 413,
    });
  });

  it("refuses an empty file", () => {
    expect(inspectFile("empty.txt", new Uint8Array(0))).toMatchObject({
      code: "empty_file",
    });
  });

  it("refuses a path-traversal name", () => {
    expect(inspectFile("../../etc/passwd", bytesOf("x"))).toMatchObject({
      code: "invalid_filename",
    });
  });
});

describe("isFileRejection", () => {
  it("only matches a rejection envelope", () => {
    expect(isFileRejection({ kind: "rejection", code: "empty_file" })).toBe(true);
    expect(isFileRejection({ kind: "accepted" })).toBe(false);
    expect(isFileRejection(null)).toBe(false);
    expect(isFileRejection("nope")).toBe(false);
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1023, "1023 B"],
    [1024, "1 KiB"],
    [1536, "1.5 KiB"],
    [10240, "10 KiB"],
    [1048576, "1 MiB"],
    [20 * 1024 * 1024, "20 MiB"],
  ])("formats %d as %s", (size, expected) => {
    expect(formatBytes(size)).toBe(expected);
  });

  it("never renders a meaningless size", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("isSupportedUploadName", () => {
  it.each([
    "notes.pdf",
    "scan.PNG",
    "photo.jpeg",
    "photo.jpg",
    "plain.txt",
    "notes.md",
    "notes.markdown",
  ])("accepts %s against the shared allow list", (name) => {
    expect(isSupportedUploadName(name)).toBe(true);
  });

  it.each(["setup.exe", "archive.zip", "script.sh", "notes", "notes."])(
    "refuses %s without a round trip",
    (name) => {
      expect(isSupportedUploadName(name)).toBe(false);
    },
  );

  it("matches the server's extension list rather than a second copy", () => {
    // The client check reads RESOURCE_EXTENSIONS, the same constant the
    // server's inspectFile consults — an extension added there lights up here.
    expect(isSupportedUploadName("anything.markdown")).toBe(true);
  });
});
