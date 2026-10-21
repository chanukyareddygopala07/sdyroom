"use client";

import {
  COMMUNITY_CATEGORIES,
  CATEGORY_LABELS,
  communityApiErrorMessage,
} from "@/components/communities/_shared";
import { CommunityCard } from "@/components/communities/community-card";
import { CommunityCreateForm } from "@/components/communities/community-create-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { listCommunitiesClient } from "@/lib/communities/api";
import type { CommunityRow } from "@/lib/communities/types";
import { Plus, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * Community discovery: free-text search, category chips and the card grid.
 * Every read goes through the signed-in client fetcher, so private
 * communities can never appear here — the server only ever lists public
 * rows.
 */
export function CommunityDiscovery() {
  const [draft, setDraft] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [communities, setCommunities] = useState<CommunityRow[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // No synchronous setState here (react-hooks/set-state-in-effect): the
  // callers below paint "loading" in their event handlers, and this only
  // reports what the server answered.
  const load = useCallback(
    async (query: string, selected: string | null) => {
      try {
        const page = await listCommunitiesClient({
          ...(query !== "" ? { q: query } : {}),
          ...(selected !== null ? { category: selected } : {}),
          limit: 50,
        });
        setCommunities(page.communities);
        setError(null);
        setStatus("ready");
      } catch (caught) {
        setStatus("error");
        setError(
          communityApiErrorMessage(
            caught,
            "Communities could not be loaded.",
          ),
        );
      }
    },
    [],
  );

  useEffect(() => {
    // Deferred through a promise callback: the loader must not start
    // synchronously inside the effect body (react-hooks/set-state-in-effect).
    void Promise.resolve().then(() => load(appliedQuery, category));
  }, [load, appliedQuery, category]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Communities</h1>
          <p className="text-sm text-muted-foreground">
            End-to-end encrypted study communities. Only members can read what
            is said inside.
          </p>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden="true" />
          New community
        </Button>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const next = draft.trim();
          if (next === appliedQuery) return;
          setStatus("loading");
          setAppliedQuery(next);
        }}
        className="flex flex-wrap items-end gap-2"
        role="search"
      >
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor="community-search">Search</Label>
          <Input
            id="community-search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search communities"
            maxLength={60}
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          disabled={draft.trim() === appliedQuery}
        >
          <Search aria-hidden="true" />
          Search
        </Button>
      </form>

      <div
        role="group"
        aria-label="Filter by category"
        className="flex flex-wrap gap-2"
      >
        <Button
          type="button"
          size="sm"
          variant={category === null ? "default" : "outline"}
          aria-pressed={category === null}
          onClick={() => {
            if (category === null) return;
            setStatus("loading");
            setCategory(null);
          }}
        >
          All
        </Button>
        {COMMUNITY_CATEGORIES.map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={category === value ? "default" : "outline"}
            aria-pressed={category === value}
            onClick={() => {
              setStatus("loading");
              setCategory(category === value ? null : value);
            }}
          >
            {CATEGORY_LABELS[value]}
          </Button>
        ))}
      </div>

      {status === "loading" ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, index) => (
            <li key={index} className="h-40 animate-pulse rounded-xl bg-accent" />
          ))}
        </ul>
      ) : status === "error" ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setStatus("loading");
              void load(appliedQuery, category);
            }}
          >
            Try again
          </Button>
        </div>
      ) : communities.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {appliedQuery || category
            ? "No communities match that search. Try a different word or category."
            : "No communities yet. Start the first one."}
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {communities.map((community) => (
            <li key={community.id}>
              <CommunityCard community={community} />
            </li>
          ))}
        </ul>
      )}

      <CommunityCreateForm
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}
