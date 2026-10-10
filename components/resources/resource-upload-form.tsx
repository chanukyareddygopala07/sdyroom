"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatBytes, isSupportedUploadName } from "@/lib/resources/files";
import type { ResourceQuota } from "@/lib/resources/quota";
import type { StudyResource } from "@/lib/resources/types";
import { MAX_FILE_BYTES, MAX_TITLE_CHARS } from "@/lib/validation/resources";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type UploadOutcome = {
  resource?: StudyResource;
  error?: { code?: string; message?: string };
};

/**
 * Posts one multipart upload with `XMLHttpRequest` rather than `fetch`.
 *
 * `fetch` cannot report upload progress, and the milestone asks for it: XHR's
 * `upload.onprogress` is the only straightforward way to show a student on a
 * slow connection that their 18 MB scan is actually moving. The session cookie
 * rides along unchanged, so nothing about authentication differs.
 */
function postUpload(
  form: FormData,
  onProgress: (percent: number) => void,
): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/resources");
    request.responseType = "text";

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    });

    request.addEventListener("load", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(request.responseText) as unknown;
      } catch {
        body = null;
      }
      const envelope =
        body !== null && typeof body === "object"
          ? (body as { resource?: StudyResource; error?: { code?: string; message?: string } })
          : {};

      if (request.status >= 200 && request.status < 300 && envelope.resource) {
        resolve({ resource: envelope.resource });
        return;
      }
      resolve({ error: envelope.error ?? {} });
    });

    request.addEventListener("error", () => {
      resolve({ error: { message: "Could not reach the server." } });
    });
    request.addEventListener("abort", () => {
      resolve({ error: { message: "The upload was cancelled." } });
    });

    request.send(form);
  });
}

export function ResourceUploadForm({
  scope,
  idPrefix,
  quota,
  onUploaded,
}: {
  scope: { kind: "personal" } | { kind: "room"; roomId: string };
  idPrefix: string;
  /** Storage quota for this scope, as `GET /api/resources` reports it. */
  quota?: ResourceQuota | null;
  onUploaded: (resource: StudyResource) => void;
}) {
  const router = useRouter();
  const fileInputId = `${idPrefix}-upload-file`;
  const titleInputId = `${idPrefix}-upload-title`;
  const subjectInputId = `${idPrefix}-upload-subject`;
  const chapterInputId = `${idPrefix}-upload-chapter`;

  const formRef = useRef<HTMLFormElement>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const maxMiB = Math.floor(MAX_FILE_BYTES / (1024 * 1024));
  // Prop-driven, so it clears itself the moment a delete (or any
  // `router.refresh()`) brings back fresh numbers — no local flag to forget.
  const quotaFull =
    quota !== undefined && quota !== null && quota.used_bytes >= quota.limit_bytes;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) {
      return;
    }

    const formElement = event.currentTarget;
    const data = new FormData(formElement);
    const file = data.get("file");

    if (!(file instanceof File) || file.size === 0) {
      setError("Choose a file to upload.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(`Files must be ${maxMiB} MiB or smaller.`);
      return;
    }
    if (!isSupportedUploadName(file.name)) {
      setError("Only PDF, PNG, JPEG, TXT and Markdown files can be uploaded.");
      return;
    }
    if (quotaFull) {
      setError(
        "You have reached your storage limit. Delete some files to free space and try again.",
      );
      return;
    }

    setBusy(true);
    setError(null);
    setProgress(0);

    const form = new FormData();
    form.set("file", file);
    for (const key of ["title", "subject", "chapter"] as const) {
      const value = data.get(key);
      if (typeof value === "string" && value.trim() !== "") {
        form.set(key, value);
      }
    }
    if (scope.kind === "room") {
      form.set("room_id", scope.roomId);
    }

    const outcome = await postUpload(form, setProgress);

    if (outcome.resource) {
      formElement.reset();
      setFileName("");
      setProgress(0);
      onUploaded(outcome.resource);
      router.refresh();
      return;
    }

    setProgress(0);
    if (outcome.error?.code === "unauthenticated") {
      router.push("/auth/login");
      return;
    }
    setError(
      outcome.error?.message ?? "The file could not be uploaded. Please try again.",
    );
  };

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void handleSubmit(event)}
      className="flex flex-col gap-3 rounded-xl border p-4"
      aria-labelledby={`${idPrefix}-upload-heading`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${idPrefix}-upload-heading`} className="text-sm font-semibold">
          Upload a file
        </h3>
        {quota && (
          <p className="text-xs text-muted-foreground">
            {formatBytes(quota.used_bytes)} of {formatBytes(quota.limit_bytes)} used
          </p>
        )}
      </div>

      {quotaFull && (
        <p className="text-xs text-warning" role="status">
          Storage full — delete files to make room for new uploads.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fileInputId}>File</Label>
        <Input
          id={fileInputId}
          name="file"
          type="file"
          required
          accept=".pdf,.png,.jpg,.jpeg,.txt,.md,.markdown,application/pdf,image/png,image/jpeg,text/plain,text/markdown"
          className="pt-1.5"
          aria-describedby={`${idPrefix}-upload-help`}
          onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")}
        />
        <p id={`${idPrefix}-upload-help`} className="text-xs text-muted-foreground">
          PDF, PNG, JPEG, TXT or Markdown — up to {maxMiB} MiB.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={titleInputId}>Title</Label>
        <Input
          id={titleInputId}
          name="title"
          required
          maxLength={MAX_TITLE_CHARS}
          placeholder="Rotational dynamics — class notes"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={subjectInputId}>Subject</Label>
          <Input
            id={subjectInputId}
            name="subject"
            maxLength={80}
            placeholder="Physics"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={chapterInputId}>Chapter</Label>
          <Input
            id={chapterInputId}
            name="chapter"
            maxLength={80}
            placeholder="Rotational motion"
          />
        </div>
      </div>

      {busy && (
        <div className="flex flex-col gap-1" aria-live="polite">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label="Upload progress"
            className="h-2 w-full overflow-hidden rounded-full bg-accent"
          >
            <div
              className="h-full bg-primary transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground">
            {fileName ? `Uploading ${fileName}… ` : "Uploading… "}
            {progress}%
          </span>
        </div>
      )}

      {error && (
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
      )}

      <div>
        <Button
          type="submit"
          size="sm"
          disabled={busy || quotaFull}
          aria-busy={busy}
        >
          {busy ? "Uploading…" : "Upload"}
        </Button>
      </div>
    </form>
  );
}
