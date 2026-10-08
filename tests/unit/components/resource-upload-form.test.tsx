// @vitest-environment jsdom
import { ResourceUploadForm } from "@/components/resources/resource-upload-form";
import { QUOTA_EXCEEDED_MESSAGE } from "@/lib/resources/queries";
import type { ResourceQuota } from "@/lib/resources/quota";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom's FormData construction reads the input's *internal* FileList, while
// the usual `fireEvent.change(input, { target: { files } })` trick only
// defines `files` on the wrapper object the tests see — so the form would
// come back with an empty placeholder file. These two helpers reach the same
// internal state jsdom itself uses (impl wrappers are jsdom's own webidl2js
// layout), keeping the FormData read under test real instead of stubbed.
const require = createRequire(import.meta.url);
const jsdomUtils = require("jsdom/lib/generated/idl/utils.js");

function attachFileTo(input: HTMLInputElement, file: File) {
  const implList = jsdomUtils.implForWrapper(input.files);
  implList.push(jsdomUtils.implForWrapper(file));
}

const { push, refresh } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

const QUOTA: ResourceQuota = {
  scope: "user",
  used_bytes: 1_048_576,
  limit_bytes: 1_073_741_824,
  user_used_bytes: 1_048_576,
  user_limit_bytes: 1_073_741_824,
};

const FULL_QUOTA: ResourceQuota = {
  ...QUOTA,
  used_bytes: QUOTA.limit_bytes,
};

const RESOURCE = {
  id: "44444444-4444-4444-8444-444444444444",
  title: "Rotational motion",
  original_filename: "rotational.pdf",
  content_type: "application/pdf",
  size_bytes: 12,
  subject: null,
  chapter: null,
  room_id: null,
  created_at: "2026-10-06T07:00:00+00:00",
  updated_at: "2026-10-06T07:00:00+00:00",
};

/**
 * A controllable XMLHttpRequest: the form resolves the moment `load` fires,
 * so a test decides exactly what status and envelope come back.
 */
class FakeXHR {
  static instances: FakeXHR[] = [];
  upload = { addEventListener: vi.fn() };
  responseType = "";
  responseText = "";
  status = 0;
  open = vi.fn();
  send = vi.fn();
  private listeners: Record<string, (() => void)[]> = {};

  constructor() {
    FakeXHR.instances.push(this);
  }

  addEventListener(event: string, handler: () => void) {
    (this.listeners[event] ??= []).push(handler);
  }

  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    for (const handler of this.listeners.load ?? []) handler();
  }

  static latest(): FakeXHR {
    const request = FakeXHR.instances.at(-1);
    if (!request) throw new Error("no upload request was started");
    return request;
  }
}

function chooseFile(name = "notes.pdf", content = "%PDF-1.4\nx\n") {
  const file = new File([content], name, { type: "application/pdf" });
  const input = screen.getByLabelText("File") as HTMLInputElement;
  attachFileTo(input, file);
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

async function submit() {
  const form = document.querySelector("form");
  if (!form) throw new Error("no form rendered");
  fireEvent.submit(form);
}

function renderForm(quota?: ResourceQuota | null) {
  const onUploaded = vi.fn();
  render(
    <ResourceUploadForm
      scope={{ kind: "personal" }}
      idPrefix="personal"
      quota={quota}
      onUploaded={onUploaded}
    />,
  );
  return { onUploaded };
}

describe("ResourceUploadForm", () => {
  beforeEach(() => {
    FakeXHR.instances = [];
    push.mockReset();
    refresh.mockReset();
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows how much of the quota is used", () => {
    renderForm(QUOTA);

    expect(screen.getByText("1 MiB of 1 GiB used")).toBeTruthy();
  });

  it("disables the submit button and explains why when the quota is full", () => {
    renderForm(FULL_QUOTA);

    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    expect(screen.getByRole("status").textContent).toContain(
      "Storage full — delete files",
    );
  });

  it("leaves the form usable when the quota numbers could not be read", () => {
    renderForm(null);

    expect(screen.queryByText(/used$/)).toBeNull();
    expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled();
  });

  it("refuses an unsupported extension before sending anything", async () => {
    renderForm(QUOTA);

    chooseFile("setup.exe", "MZ");
    await submit();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Only PDF, PNG, JPEG, TXT and Markdown files can be uploaded.",
      );
    });
    expect(FakeXHR.instances).toHaveLength(0);
  });

  it("refuses an empty file selection before sending anything", async () => {
    renderForm(QUOTA);

    await submit();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Choose a file to upload.",
      );
    });
    expect(FakeXHR.instances).toHaveLength(0);
  });

  it("posts the upload and hands the stored resource back", async () => {
    const { onUploaded } = renderForm(QUOTA);

    chooseFile();
    await submit();

    await waitFor(() => {
      expect(FakeXHR.instances).toHaveLength(1);
    });
    FakeXHR.latest().respond(201, { resource: RESOURCE });

    await waitFor(() => {
      expect(onUploaded).toHaveBeenCalledWith(RESOURCE);
    });
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the server's quota refusal from the 409 envelope", async () => {
    renderForm(QUOTA);

    chooseFile();
    await submit();

    await waitFor(() => {
      expect(FakeXHR.instances).toHaveLength(1);
    });
    FakeXHR.latest().respond(409, {
      error: { code: "quota_exceeded", message: QUOTA_EXCEEDED_MESSAGE },
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        QUOTA_EXCEEDED_MESSAGE,
      );
    });
  });

  it("shows the server's rate-limit refusal from the 429 envelope", async () => {
    renderForm(QUOTA);

    chooseFile();
    await submit();

    await waitFor(() => {
      expect(FakeXHR.instances).toHaveLength(1);
    });
    FakeXHR.latest().respond(429, {
      error: {
        code: "rate_limited",
        message: "Too many uploads — wait about a minute and try again.",
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Too many uploads — wait about a minute and try again.",
      );
    });
  });

  it("sends the student to login when the session expired mid-upload", async () => {
    renderForm(QUOTA);

    chooseFile();
    await submit();

    await waitFor(() => {
      expect(FakeXHR.instances).toHaveLength(1);
    });
    FakeXHR.latest().respond(401, {
      error: { code: "unauthenticated", message: "Sign in to manage your files." },
    });

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/auth/login");
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
