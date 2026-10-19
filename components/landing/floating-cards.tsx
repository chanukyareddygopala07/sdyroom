import { Clock, Target, Users } from "lucide-react";

/**
 * The three illustrative hero cards (focus session, study room, next step).
 *
 * They are design previews only — not rooms, not users, not live session
 * data — so the whole cluster is hidden from assistive technology and kept
 * out of the tab order; the real product copy sits beside them. Each card
 * labels itself visually ("FOCUS SESSION" etc.) so sighted readers cannot
 * mistake it for a live widget either.
 *
 * Decorative hover lift only (a couple of pixels), collapsed for students on
 * `prefers-reduced-motion` by the global switch in `globals.css`. Nothing
 * animates on its own: no loops, no entrance choreography.
 */
type CardSpec = {
  label: string;
  icon: typeof Target;
  title: React.ReactNode;
  note: string;
};

const CARDS: readonly CardSpec[] = [
  {
    label: "Focus session",
    icon: Clock,
    title: <span className="font-mono text-3xl font-semibold">25:00</span>,
    note: "One goal. One focused sprint.",
  },
  {
    label: "Study room",
    icon: Users,
    title: <span className="font-semibold">NEET Biology · Cell Structure</span>,
    note: "Shared goals · Group focus",
  },
  {
    label: "Your next step",
    icon: Target,
    title: <span className="font-semibold">Finish one topic</span>,
    note: "Make progress together",
  },
] as const;

function FloatingCard({ spec }: { spec: CardSpec }) {
  const Icon = spec.icon;
  return (
    <div className="w-full rounded-2xl border border-white/10 bg-white/[0.06] p-4 shadow-xl shadow-black/30 backdrop-blur-sm transition-transform duration-200 hover:-translate-y-0.5">
      <p className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.18em] text-[hsl(198_93%_60%)] uppercase">
        <Icon className="size-3" aria-hidden="true" />
        {spec.label}
      </p>
      <p className="mt-2 text-[#F5F7FF]">{spec.title}</p>
      <p className="mt-1 text-xs text-[#A8B4CC]">{spec.note}</p>
    </div>
  );
}

/**
 * Desktop presentation: a deliberately asymmetric cluster floated around the
 * right side of the hero, with small rotations and soft shadows. Fully
 * `aria-hidden` — see the note above.
 */
export function FloatingCardsDesktop() {
  return (
    <div aria-hidden="true" className="absolute inset-0">
      <div className="absolute top-6 right-4 w-56 rotate-[-2deg] transition-transform duration-200 hover:-translate-y-0.5 xl:right-10">
        <FloatingCard spec={CARDS[1]!} />
      </div>
      <div className="absolute top-48 left-2 w-52 rotate-[1.5deg] transition-transform duration-200 hover:-translate-y-0.5 xl:left-6">
        <FloatingCard spec={CARDS[0]!} />
      </div>
      <div className="absolute right-8 bottom-10 w-52 rotate-[-1deg] transition-transform duration-200 hover:-translate-y-0.5 xl:right-16">
        <FloatingCard spec={CARDS[2]!} />
      </div>
    </div>
  );
}

/**
 * Phone/tablet presentation: the same previews as a plain in-flow stack
 * under the hero copy, so nothing is positioned over text at small widths
 * and no rotation can push the page sideways. Also `aria-hidden`.
 */
export function FloatingCardsStack() {
  return (
    <div
      aria-hidden="true"
      className="grid gap-3 sm:grid-cols-3 lg:hidden"
    >
      {CARDS.map((spec) => (
        <FloatingCard key={spec.label} spec={spec} />
      ))}
    </div>
  );
}
