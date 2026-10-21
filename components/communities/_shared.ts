/**
 * Small shared pieces for the communities UI: the curated emoji list, the
 * sticker pack loader/renderer, category labels and the one place every
 * community call turns an error into user-facing copy (including the
 * rate-limit countdown the server asks for).
 *
 * The sticker renderer deliberately never touches `dangerouslySetInnerHTML`
 * (banned by PR 21): the pack's SVG strings are parsed with `DOMParser` and
 * mapped to React elements, so `currentColor` keeps adapting to light/dark
 * themes and the CSP never sees an inline HTML injection.
 */

import { CommunityApiError } from "@/lib/communities/api";
import type { CommunityCategory } from "@/lib/communities/types";
import { createElement, useEffect, useState, type ReactNode } from "react";

/** Closed category vocabulary — mirrors lib/validation/communities.ts. */
export const COMMUNITY_CATEGORIES = [
  "study",
  "exams",
  "subjects",
  "projects",
  "campus",
  "other",
] as const;

export const CATEGORY_LABELS: Record<CommunityCategory, string> = {
  study: "Study groups",
  exams: "Exam prep",
  subjects: "Subjects",
  projects: "Projects",
  campus: "Campus life",
  other: "Other",
};

/** Curated native emojis for the composer picker — no dependency. */
export const COMPOSER_EMOJIS = [
  "😀", "😄", "😊", "😍", "🤔", "😅", "😂", "🥰",
  "😎", "🤩", "😮", "😴", "🙃", "👍", "👎", "👏",
  "🙌", "🤝", "🙏", "💪", "✌️", "🤞", "👌", "☕",
  "📚", "🧠", "🚀", "🎯", "✅", "✨", "🔥", "🎉",
] as const;

/** Emojis offered by the per-message reaction picker. */
export const REACTION_EMOJIS = [
  "👍", "❤️", "😂", "🎉", "🔥", "👀", "🙌", "✅",
] as const;

export type StickerEntry = {
  id: string;
  alt: string;
  svg: string;
};

export type StickerPack = {
  pack: string;
  stickers: StickerEntry[];
};

/**
 * One fetch of the pack per page session. The promise itself is the cache,
 * so several mounts (composer, message list) share a single request and a
 * failed load is not retried in a loop.
 */
let stickerPackPromise: Promise<StickerPack> | null = null;

export function loadStickers(): Promise<StickerPack> {
  stickerPackPromise ??= fetch("/stickers/stickers.json")
    .then(async (response) => {
      if (!response.ok) {
        throw new Error("stickers unavailable");
      }
      const body: unknown = await response.json();
      const pack = parseStickerPack(body);
      if (!pack) {
        throw new Error("stickers malformed");
      }
      return pack;
    })
    .catch((error: unknown) => {
      // A failed load must not poison the cache for a later retry.
      stickerPackPromise = null;
      throw error;
    });
  return stickerPackPromise;
}

function parseStickerPack(raw: unknown): StickerPack | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as { pack?: unknown; stickers?: unknown };
  if (typeof value.pack !== "string" || !Array.isArray(value.stickers)) {
    return null;
  }
  const stickers: StickerEntry[] = [];
  for (const item of value.stickers) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as { id?: unknown; alt?: unknown; svg?: unknown };
    if (
      typeof entry.id === "string" &&
      typeof entry.alt === "string" &&
      typeof entry.svg === "string"
    ) {
      stickers.push({ id: entry.id, alt: entry.alt, svg: entry.svg });
    }
  }
  return { pack: value.pack, stickers };
}

/** Load the sticker pack client-side; `null` until it arrives (or never). */
export function useStickers(): StickerPack | null {
  const [pack, setPack] = useState<StickerPack | null>(null);
  useEffect(() => {
    let disposed = false;
    loadStickers().then(
      (next) => {
        if (!disposed) setPack(next);
      },
      () => {
        // Unavailable pack: callers render the alt-text fallback.
      },
    );
    return () => {
      disposed = true;
    };
  }, []);
  return pack;
}

const svgCache = new Map<string, ReactNode | null>();

function elementFromNode(node: Element): ReactNode {
  const props: Record<string, string> = {};
  for (const attribute of Array.from(node.attributes)) {
    const name = attribute.name === "class" ? "className" : attribute.name;
    props[name] = attribute.value;
  }
  const children: ReactNode[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      children.push(elementFromNode(child as Element));
    } else if (child.nodeType === Node.TEXT_NODE && child.nodeValue) {
      children.push(child.nodeValue);
    }
  }
  // Varargs children reconcile positionally exactly like static JSX
  // children, so no keys are set — an explicit per-tag key would collide
  // between siblings and React would warn in development.
  return createElement(node.nodeName.toLowerCase(), props, ...children);
}

/**
 * Parse one pack SVG into React elements. Returns `null` when the string is
 * not a well-formed `<svg>` document, so a hostile pack entry degrades to
 * the caller's fallback instead of rendering markup.
 */
export function stickerSvgElement(svg: string): ReactNode | null {
  const cached = svgCache.get(svg);
  if (cached !== undefined) return cached;

  let result: ReactNode | null = null;
  if (typeof DOMParser !== "undefined") {
    try {
      const document = new DOMParser().parseFromString(
        svg,
        "image/svg+xml",
      );
      const root = document.documentElement;
      const failed =
        root.nodeName.toLowerCase() !== "svg" ||
        document.querySelector("parsererror") !== null;
      result = failed ? null : elementFromNode(root);
    } catch {
      result = null;
    }
  }
  svgCache.set(svg, result);
  return result;
}

/**
 * Every community fetch failure becomes copy here: the server's message
 * verbatim, except rate limits which carry the countdown the server asked
 * for (`retry-after`), falling back to its message when the header is gone.
 */
export function communityApiErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof CommunityApiError) {
    if (error.code === "rate_limited" && error.retryAfter !== null) {
      return `You're doing that too quickly — try again in ${error.retryAfter}s`;
    }
    return error.message;
  }
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return fallback;
}

/** True when the failure means "GIFs are not configured here". */
export function isGifUnavailable(error: unknown): boolean {
  return error instanceof CommunityApiError && error.code === "gif_unavailable";
}

/** CSS-escaped `url("…")` value for a background image from an untrusted URL. */
export function cssUrl(url: string): string {
  return `url(${JSON.stringify(url)})`;
}

/** "1,024 members" with a singular plural. */
export function memberCountLabel(count: number): string {
  return `${count} ${count === 1 ? "member" : "members"}`;
}

/** Local time, matching the chat panel's `Intl` convention (no locale drift). */
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});

export function formatMessageTime(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : timeFormat.format(date);
}

/** Suggest a slug from a community name (server re-validates the shape). */
export function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
