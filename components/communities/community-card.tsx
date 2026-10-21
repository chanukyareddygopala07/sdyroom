import {
  CATEGORY_LABELS,
  memberCountLabel,
} from "@/components/communities/_shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CommunityRow } from "@/lib/communities/types";
import Link from "next/link";

/**
 * Discovery card for one community. The title link carries an overlay
 * (`after:inset-0`) so the whole card is clickable while staying a single
 * anchor with the community name as its accessible name — the same pattern
 * as the room card. Joining itself happens on the community page, where the
 * viewer's membership is known.
 */
export function CommunityCard({ community }: { community: CommunityRow }) {
  return (
    <article className="relative flex h-full flex-col gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-semibold leading-snug">
          <Link
            href={`/communities/${community.id}`}
            aria-label={community.name}
            className="focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring after:absolute after:inset-0 after:rounded-xl"
          >
            {community.name}
          </Link>
        </h2>
        <Badge variant="outline">
          {CATEGORY_LABELS[community.category] ?? community.category}
        </Badge>
      </div>

      {community.description && (
        <p className="line-clamp-3 text-sm text-muted-foreground">
          {community.description}
        </p>
      )}

      <div className="relative z-10 mt-auto flex flex-col gap-3">
        <span className="text-sm text-muted-foreground">
          {memberCountLabel(community.member_count)}
        </span>
        <Button asChild size="sm" variant="secondary">
          <Link href={`/communities/${community.id}`}>
            {community.visibility === "private" ? "View community" : "Open"}
          </Link>
        </Button>
      </div>
    </article>
  );
}
