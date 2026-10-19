import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ROOM_QUERY_MAX } from "@/lib/validation/rooms";

/**
 * Suggested searches, mirroring the discovery box's placeholder vocabulary.
 * They are plain links with the real `q` parameter, so they work before any
 * hydration and land on the exact same `/rooms` search the form submits.
 */
const TRY_TERMS = ["biology", "cell structure", "neet"] as const;

/**
 * The hero's discovery entry point: a plain `GET` form that navigates to
 * `/rooms?q=…` — the real room-discovery route and its real query
 * parameter, with no new API, no client state, and no JavaScript needed.
 *
 * Auth and visibility rules are the ones `/rooms` already enforces: a
 * signed-out visitor who searches is taken through the existing sign-in
 * redirect (middleware), and that route only ever lists rooms its query is
 * allowed to see. Empty and no-match answers are rendered there too
 * ("No public rooms match your search."). Nothing here invents results.
 */
export function HeroSearch() {
  return (
    <div className="w-full max-w-xl">
      <form role="search" action="/rooms" method="get">
        <label htmlFor="hero-search" className="sr-only">
          Find a study room, subject, or exam
        </label>
        <div className="flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] p-1.5 pl-4 backdrop-blur-sm focus-within:ring-2 focus-within:ring-[hsl(198_93%_60%)]">
          <Input
            id="hero-search"
            name="q"
            type="search"
            maxLength={ROOM_QUERY_MAX}
            placeholder="Find a study room, subject, or exam..."
            autoComplete="off"
            className="h-10 min-w-0 flex-1 border-0 bg-transparent px-0 text-[#F5F7FF] shadow-none ring-offset-0 focus-visible:ring-0 placeholder:text-[#A8B4CC]"
          />
          <Button
            type="submit"
            className="h-10 shrink-0 rounded-full bg-gradient-brand px-5 text-white hover:brightness-110"
          >
            Explore rooms
          </Button>
        </div>
      </form>
      <p className="mt-3 pl-4 text-xs text-[#A8B4CC]">
        Try:{" "}
        {TRY_TERMS.map((term, index) => (
          <span key={term}>
            {index > 0 && <span aria-hidden="true"> · </span>}
            <a
              href={`/rooms?q=${encodeURIComponent(term)}`}
              className="underline underline-offset-4 transition-colors hover:text-[#F5F7FF] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[hsl(198_93%_60%)]"
            >
              {term}
            </a>
          </span>
        ))}
      </p>
    </div>
  );
}
