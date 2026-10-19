/**
 * AI status display (PR 12) — the chip every resource row wears, plus the
 * demo-mode banner 13/14/15 will reuse.
 *
 * Presentation only: no fetching, no config reads. That keeps the component
 * importable from client *and* server graphs (`lib/ai/config` stays server
 * side — the banner's copy is passed in as a string, never read from env in
 * the browser) and makes the label table unit-testable as plain data.
 *
 * Labels are the contract from `docs/prs/PR-12`: `Not indexed`,
 * `Indexing… (step)`, `Ready for AI`, `Failed — <reason>`.
 */

import { Badge } from "@/components/ui/badge";
import type {
  AiDocumentStatusInfo,
  IngestErrorCode,
  IngestStatus,
} from "@/lib/ai/types";

const FAILURE_REASONS: Record<IngestErrorCode, string> = {
  no_text_layer: "no text layer",
  extract_failed: "couldn't read the file",
  extracted_too_large: "extracted text too large",
  ingest_failed: "indexing failed",
  ai_quota_exceeded: "daily AI limit reached",
  ai_provider_failed: "AI service unavailable",
};

/** Per-step wording inside `Indexing… (step)`. */
const STEP_LABELS: Record<Exclude<IngestStatus, "pending" | "ready" | "failed">, string> = {
  extracting: "reading",
  chunking: "chunking",
  embedding: "embedding",
};

/**
 * True when the chip should read as a failure. `error_code` wins over
 * `status`: an embed failure keeps the row at `embedding` (so it stays
 * resumable) but must *display* as the failure it is.
 */
export function aiHasFailed(
  ai: AiDocumentStatusInfo | null,
): ai is AiDocumentStatusInfo & { error_code: IngestErrorCode } {
  return ai !== null && ai.error_code !== null;
}

/** The four published labels, computed from the stored pair. */
export function aiStatusText(ai: AiDocumentStatusInfo | null): string {
  if (ai === null || ai.status === "pending") {
    return "Not indexed";
  }
  if (ai.error_code !== null) {
    return `Failed — ${FAILURE_REASONS[ai.error_code] ?? "indexing failed"}`;
  }
  if (ai.status === "ready") {
    return "Ready for AI";
  }
  if (ai.status === "failed") {
    // Defensive: a `failed` row always carries an error_code, but a
    // hand-written row might not — never render a bare "Failed".
    return "Failed — indexing failed";
  }
  return `Indexing… ${STEP_LABELS[ai.status]}`;
}

type ChipVariant = "outline" | "secondary" | "default" | "destructive";

function chipVariant(ai: AiDocumentStatusInfo | null): ChipVariant {
  if (aiHasFailed(ai)) return "destructive";
  if (ai !== null && ai.status === "ready") return "default";
  if (ai !== null && ai.status !== "pending") return "secondary";
  return "outline";
}

/**
 * The status chip. Text alone carries the state (`Badge` is decorative
 * chrome), so the chip needs no extra ARIA — it is readable as-is.
 */
export function AiStatusChip({ ai }: { ai: AiDocumentStatusInfo | null }) {
  return (
    <Badge variant={chipVariant(ai)} data-testid="ai-status-chip">
      {aiStatusText(ai)}
    </Badge>
  );
}

/**
 * Global demo-mode banner (`AI_PROVIDER` resolved to `mock` server-side).
 * The gating decision and the copy are inputs — a client component must never
 * read `AI_*` environment variables itself.
 */
export function AiDemoBanner({ text }: { text: string }) {
  return (
    <div
      role="status"
      className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-center text-xs font-medium text-amber-800 dark:text-amber-400"
      data-testid="ai-demo-banner"
    >
      {text}
    </div>
  );
}
