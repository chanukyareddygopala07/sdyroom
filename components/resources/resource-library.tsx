"use client";

import { ReportDialog } from "@/components/report-dialog";
import { ResourceUploadForm } from "@/components/resources/resource-upload-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatBytes } from "@/lib/resources/files";
import type { StudyResource } from "@/lib/resources/types";
import { useRouter } from "next/navigation";
import { useState } from "react";

export type ResourceScope = { kind: "personal" } | { kind: "room"; roomId: string };

type Filters = { q: string; subject: string; chapter: string };

const PAGE_SIZE = 50;

const EMPTY_FILTERS: Filters = { q: "", subject: "", chapter: "" };

function buildQuery(scope: ResourceScope, filters: Filters, offset: number): string {
  const params = new URLSearchParams();
  if (scope.kind === "room") {
    params.set("room_id", scope.roomId);
  } else {
    params.set("scope", "personal");
  }
  if (filters.q.trim() !== "") params.set("q", filters.q.trim());
  if (filters.subject.trim() !== "") params.set("subject", filters.subject.trim());
  if (filters.chapter.trim() !== "") params.set("chapter", filters.chapter.trim());
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));
  return params.toString();
}

function formatDate(iso: string): string {
  // Fixed UTC date, never toLocaleDateString: the server and the browser must
  // agree or hydration mismatches on every render.
  return iso.slice(0, 10);
}

function contentTypeLabel(contentType: string): string {
  switch (contentType) {
    case "application/pdf":
      return "PDF";
    case "image/png":
      return "PNG";
    case "image/jpeg":
      return "JPEG";
    case "text/markdown":
      return "Markdown";
    default:
      return "Text";
  }
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <ul className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <li key={index} className="h-20 animate-pulse rounded-lg bg-accent" />
      ))}
    </ul>
  );
}

/**
 * The resource manager used by both the personal library and a room's
 * Resources section. The `scope` prop is the only difference, and it decides
 * the endpoint, the heading wording and the storage target — a personal file
 * and a shared file can never be produced by the same request.
 *
 * Every write goes through the API and only the returned row is trusted. RLS
 * decides what may be read, so a 404 on download simply reports the failure
 * rather than pretending the file is missing from the list, and a failed
 * delete leaves the row visible so the student can try again.
 */
export function ResourceLibrary({
  scope,
  initialResources,
  idPrefix,
  heading,
  description,
  level = 1,
}: {
  scope: ResourceScope;
  initialResources: StudyResource[];
  idPrefix: string;
  heading: string;
  description: string;
  /** h1 for a page of its own, h2 when mounted inside a workspace. */
  level?: 1 | 2;
}) {
  const router = useRouter();
  const isRoom = scope.kind === "room";

  const [resources, setResources] = useState<StudyResource[]>(initialResources);
  const [hasMore, setHasMore] = useState(false);
  // `draft` drives the inputs; `applied` is what the current list actually
  // reflects. Keeping them apart means a failed search does not rewrite the
  // empty state into "no files match" while an unfiltered list is still shown.
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [status, setStatus] = useState<"ready" | "loading" | "error">("ready");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);

  /**
   * Loads a page of resources.
   *
   * A filter change (offset 0) replaces the list and shows the skeleton; a
   * "show more" appends to it, so it tracks its own busy state instead of
   * tearing the list down and losing the reader's place.
   */
  const applyFilters = async (next: Filters, offset = 0) => {
    const isRefresh = offset === 0;
    if (isRefresh) {
      setStatus("loading");
      setLoadError(null);
    } else {
      setLoadingMore(true);
    }
    setActionError(null);

    try {
      const response = await fetch(`/api/resources?${buildQuery(scope, next, offset)}`);
      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        resources?: StudyResource[];
        has_more?: boolean;
        error?: { message?: string };
      } | null;
      const list = body?.resources;

      if (!response.ok || !Array.isArray(list)) {
        const message =
          body?.error?.message ?? "Your files could not be loaded. Please try again.";
        if (isRefresh) {
          setStatus("error");
          setLoadError(message);
        } else {
          setStatus("ready");
          setActionError(message);
        }
        return;
      }

      const page = list;
      setResources((current) => (offset === 0 ? page : [...current, ...page]));
      setHasMore(body?.has_more === true);
      setApplied(next);
      if (isRefresh) {
        setNotice(null);
      }
      setStatus("ready");
    } catch {
      const message = "Could not reach the server. Please try again.";
      if (isRefresh) {
        setStatus("error");
        setLoadError(message);
      } else {
        setStatus("ready");
        setActionError(message);
      }
    } finally {
      if (!isRefresh) {
        setLoadingMore(false);
      }
    }
  };

  const openResource = async (resource: StudyResource) => {
    if (busyId !== null) return;
    setBusyId(resource.id);
    setActionError(null);

    // Open synchronously, before the await: a window opened after a network
    // round-trip is treated as a popup and blocked by default.
    const popup = window.open("", "_blank");

    try {
      const response = await fetch(`/api/resources/${resource.id}/download`);
      if (response.status === 401) {
        popup?.close();
        router.push("/auth/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        url?: string;
        error?: { message?: string };
      } | null;

      if (!response.ok || typeof body?.url !== "string") {
        popup?.close();
        setActionError(
          body?.error?.message ?? "That file could not be opened. Please try again.",
        );
        return;
      }

      if (popup) {
        popup.location.href = body.url;
      } else {
        window.location.assign(body.url);
      }
    } catch {
      popup?.close();
      setActionError("Could not reach the server. Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const deleteResource = async (resource: StudyResource) => {
    if (busyId !== null) return;
    setBusyId(resource.id);
    setActionError(null);

    try {
      const response = await fetch(`/api/resources/${resource.id}`, {
        method: "DELETE",
      });
      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      const body = (await response.json().catch(() => null)) as {
        deleted?: boolean;
        error?: { message?: string };
      } | null;

      if (!response.ok || body?.deleted !== true) {
        setActionError(
          body?.error?.message ?? "The file could not be deleted. Please try again.",
        );
        setConfirmId(null);
        return;
      }

      setResources((current) => current.filter((item) => item.id !== resource.id));
      setConfirmId(null);
      setNotice(`Deleted “${resource.title}”.`);
      router.refresh();
    } catch {
      setActionError("Could not reach the server. Please try again.");
      setConfirmId(null);
    } finally {
      setBusyId(null);
    }
  };

  const hasActiveFilters =
    applied.q !== "" || applied.subject !== "" || applied.chapter !== "";

  return (
    <section className="flex flex-col gap-5" aria-labelledby={`${idPrefix}-heading`}>
      <header className="flex flex-col gap-1">
        {level === 1 ? (
          <h1 id={`${idPrefix}-heading`} className="text-2xl font-semibold">
            {heading}
          </h1>
        ) : (
          <h2 id={`${idPrefix}-heading`} className="text-xl font-semibold">
            {heading}
          </h2>
        )}
        <p className="text-sm text-muted-foreground">{description}</p>
      </header>

      <ResourceUploadForm
        scope={scope}
        idPrefix={idPrefix}
        onUploaded={(resource) => {
          setNotice(`Uploaded “${resource.title}”.`);
          setResources((current) => [resource, ...current]);
        }}
      />

      <form
        className="flex flex-col gap-3 rounded-xl border p-4"
        aria-labelledby={`${idPrefix}-filters-heading`}
        onSubmit={(event) => {
          event.preventDefault();
          void applyFilters(draft);
        }}
      >
        <h2 id={`${idPrefix}-filters-heading`} className="text-sm font-semibold">
          Search and filter
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-q`}>Title contains</Label>
            <Input
              id={`${idPrefix}-q`}
              value={draft.q}
              maxLength={100}
              placeholder="Search by title"
              onChange={(event) => setDraft((f) => ({ ...f, q: event.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-subject`}>Subject</Label>
            <Input
              id={`${idPrefix}-subject`}
              value={draft.subject}
              maxLength={80}
              placeholder="e.g. Physics"
              onChange={(event) => setDraft((f) => ({ ...f, subject: event.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-chapter`}>Chapter</Label>
            <Input
              id={`${idPrefix}-chapter`}
              value={draft.chapter}
              maxLength={80}
              placeholder="e.g. Rotational motion"
              onChange={(event) => setDraft((f) => ({ ...f, chapter: event.target.value }))}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={status === "loading"}>
            {status === "loading" ? "Searching…" : "Search"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={status === "loading"}
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              void applyFilters(EMPTY_FILTERS);
            }}
          >
            Clear filters
          </Button>
        </div>
      </form>

      <div className="flex flex-col gap-3" aria-live="polite">
        {notice && (
          <p className="rounded-lg border border-green-600/40 bg-green-600/10 px-3 py-2 text-sm">
            {notice}
          </p>
        )}
        {actionError && (
          <div className="flex flex-col gap-2 rounded-lg border border-red-600/40 bg-red-600/10 px-3 py-2 text-sm">
            <p role="alert">{actionError}</p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setActionError(null)}
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}
      </div>

      {status === "loading" && <SkeletonRows count={3} />}

      {status === "error" && (
        <div
          className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-6 text-sm"
          role="alert"
        >
          <p>{loadError}</p>
          <Button type="button" size="sm" onClick={() => void applyFilters(applied)}>
            Retry
          </Button>
        </div>
      )}

      {status === "ready" && resources.length === 0 && (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {hasActiveFilters
            ? "No files match these filters."
            : isRoom
              ? "No files have been shared with this room yet."
              : "No files yet. Upload one above — only you can see them."}
        </div>
      )}

      {status === "ready" && resources.length > 0 && (
        <>
          <ul className="flex flex-col gap-2">
            {resources.map((resource) => {
              const isBusy = busyId === resource.id;
              const isConfirming = confirmId === resource.id;
              return (
                <li
                  key={resource.id}
                  className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <p className="break-words text-sm font-medium">{resource.title}</p>
                    <p
                      className="break-all text-xs text-muted-foreground"
                      title={resource.original_filename}
                    >
                      {resource.original_filename}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary">{contentTypeLabel(resource.content_type)}</Badge>
                      <Badge variant="outline">{formatBytes(resource.size_bytes)}</Badge>
                      {resource.subject && (
                        <Badge variant="outline">{resource.subject}</Badge>
                      )}
                      {resource.chapter && (
                        <Badge variant="outline">{resource.chapter}</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {formatDate(resource.created_at)}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      aria-label={`Open ${resource.title}`}
                      onClick={() => void openResource(resource)}
                    >
                      {isBusy ? "Opening…" : "Open"}
                    </Button>

                    {isConfirming ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          disabled={isBusy}
                          aria-label={`Confirm deleting ${resource.title}`}
                          onClick={() => void deleteResource(resource)}
                        >
                          {isBusy ? "Deleting…" : "Confirm delete"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() => setConfirmId(null)}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={isBusy}
                        aria-label={`Delete ${resource.title}`}
                        onClick={() => {
                          setActionError(null);
                          setConfirmId(resource.id);
                        }}
                      >
                        Delete
                      </Button>
                    )}

                    {isRoom && !isConfirming && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={isBusy}
                        aria-label={`Report ${resource.title}`}
                        onClick={() => {
                          setActionError(null);
                          setReportId(resource.id);
                        }}
                      >
                        Report
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {hasMore && (
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={loadingMore}
                aria-busy={loadingMore}
                onClick={() => void applyFilters(applied, resources.length)}
              >
                {loadingMore ? "Loading…" : "Show more"}
              </Button>
            </div>
          )}
        </>
      )}

      {scope.kind === "room" && reportId !== null && (
        <ReportDialog
          open
          onOpenChange={(next) => {
            if (!next) setReportId(null);
          }}
          roomId={scope.roomId}
          subject={{ type: "resource", id: reportId }}
        />
      )}
    </section>
  );
}
