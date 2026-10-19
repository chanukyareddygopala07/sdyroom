import { BrandMark } from "@/components/brand-mark";
import {
  FloatingCardsDesktop,
  FloatingCardsStack,
} from "@/components/landing/floating-cards";
import { HeroSearch } from "@/components/landing/hero-search";
import { LandingShell } from "@/components/landing/landing-shell";
import { Button } from "@/components/ui/button";
import {
  BarChart3,
  FileText,
  Layers,
  MessageCircle,
  Sparkles,
  Timer,
  Users,
} from "lucide-react";
import Link from "next/link";

/**
 * Features are limited to what the product actually ships: each card names
 * a route or workflow that exists in this repository (rooms, sessions, chat,
 * resources, quizzes/decks, planner/analytics, AI over indexed documents).
 * No invented metrics, testimonials or live counts anywhere on the page.
 */
const features = [
  {
    icon: Users,
    title: "Collaborative study rooms",
    body: "Every room states its exam track, subject, shared goal and seat count, so a group stays small enough to work together.",
  },
  {
    icon: Timer,
    title: "Focus sessions and goals",
    body: "A shared countdown, per-person studying time and recent sessions keep the room on the same clock.",
  },
  {
    icon: MessageCircle,
    title: "Room chat and accountability",
    body: "Messages are scoped to members, with moderation tools for owners and moderators when a room needs them.",
  },
  {
    icon: FileText,
    title: "Notes and resource sharing",
    body: "Share files with your room or keep a personal library — search by subject and chapter, and index documents for AI.",
  },
  {
    icon: Layers,
    title: "Quizzes and flashcards",
    body: "Generate quizzes and flashcard decks from your room's material, then drill them until the answer is automatic.",
  },
  {
    icon: BarChart3,
    title: "Study planning and analytics",
    body: "Build a study plan per room and track your own focus history, so progress is visible instead of imagined.",
  },
] as const;

const steps = [
  {
    no: "01",
    title: "Find your study room",
    body: "Search public rooms by exam track and subject, or create your own — public and discoverable, or private and unlisted.",
  },
  {
    no: "02",
    title: "Set a focus goal",
    body: "Pick one shared goal for the room, then run timed focus sprints that everyone sees on the same clock.",
  },
  {
    no: "03",
    title: "Study, share, and make progress",
    body: "Chat, resources, plans and quizzes keep the group working towards the exam — together.",
  },
] as const;

/**
 * SdyRoom's home page: an editorial, hero-led landing in the brand's
 * midnight-navy and blue-violet palette (composition inspired by bold
 * magazine landings — oversized type, technical grid, floating previews —
 * but every colour, word and link is SdyRoom's own).
 *
 * Contract notes:
 * - Exactly one `<h1>` (the responsive/a11y e2e asserts a single level-one
 *   heading on `/`), landmarks via `LandingShell`.
 * - The search is a plain `GET` form to the real `/rooms` discovery route —
 *   see `HeroSearch`.
 * - Floating cards are decorative design previews, `aria-hidden`.
 */
export default function Home() {
  return (
    <LandingShell>
      {/* ——— Hero: always-midnight panel, grid, asymmetric two-column ——— */}
      <section
        aria-labelledby="hero-heading"
        className="relative mx-auto w-full max-w-6xl overflow-hidden rounded-[1.75rem] bg-hero-midnight sm:rounded-[2.5rem]"
      >
        <div aria-hidden="true" className="absolute inset-0 bg-glow-brand" />
        <div aria-hidden="true" className="absolute inset-0 bg-grid-subtle" />
        <div className="relative z-10 grid gap-10 p-6 sm:p-10 lg:grid-cols-[1.08fr_0.92fr] lg:items-center lg:gap-6 lg:p-14">
          <div className="flex flex-col items-start">
            <div className="flex items-center gap-3">
              <BrandMark size={56} alt="" className="drop-shadow-lg" />
              <span className="text-xs font-semibold tracking-[0.3em] text-[#A8B4CC] uppercase">
                SdyRoom
              </span>
            </div>
            <p className="mt-6 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-4 py-1.5 text-[11px] font-semibold tracking-[0.2em] text-[hsl(198_93%_60%)] uppercase">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-[hsl(198_93%_60%)]"
              />
              Study rooms · Focus · Accountability
            </p>
            <h1
              id="hero-heading"
              className="mt-6 text-4xl font-extrabold tracking-tight text-[#F5F7FF] uppercase sm:text-5xl lg:text-6xl xl:text-7xl leading-[0.95]"
            >
              <span className="block">Study together.</span>
              <span className="mt-3 block w-fit rounded-full bg-gradient-brand px-6 py-2 text-white shadow-2xl shadow-brand-violet/40">
                Go further.
              </span>
            </h1>
            <p className="mt-5 max-w-md text-base text-[#A8B4CC] sm:text-lg">
              Find your focus, join a study room, and make every session count
              — together.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button
                asChild
                size="lg"
                className="rounded-full bg-gradient-brand text-white hover:bg-gradient-brand hover:brightness-110"
              >
                <Link href="/auth/sign-up">Create an account</Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="rounded-full border-white/25 bg-transparent text-[#F5F7FF] hover:bg-white/10 hover:text-[#F5F7FF]"
              >
                <Link href="/rooms">Explore study rooms</Link>
              </Button>
            </div>
            <div className="mt-7 w-full">
              <HeroSearch />
            </div>
          </div>

          {/* Floating previews: absolute cluster on desktop, in-flow stack
              below `lg` (rendered after the copy by grid order). */}
          <div className="relative hidden min-h-[26rem] lg:block">
            <FloatingCardsDesktop />
          </div>
          <div className="lg:hidden">
            <FloatingCardsStack />
          </div>
        </div>
      </section>

      {/* ——— How it works ——— */}
      <section
        id="how-it-works"
        aria-labelledby="how-heading"
        className="mx-auto w-full max-w-6xl scroll-mt-24"
      >
        <p className="text-xs font-semibold tracking-[0.25em] text-brand-blue uppercase">
          How SdyRoom works
        </p>
        <h2
          id="how-heading"
          className="mt-3 max-w-2xl text-3xl font-extrabold tracking-tight uppercase sm:text-4xl lg:text-5xl leading-[1.02]"
        >
          Three steps to a{" "}
          <span className="text-gradient-brand">better session</span>.
        </h2>
        <p className="mt-4 max-w-xl text-muted-foreground">
          No social feed, no infinite scroll — just the tools that keep a
          small room working towards one exam.
        </p>
        <ol className="mt-8 grid gap-4 md:grid-cols-3">
          {steps.map((item) => (
            <li
              key={item.no}
              className="flex flex-col gap-2 rounded-2xl border bg-card p-5 sm:p-6"
            >
              <p className="font-mono text-sm font-semibold tracking-[0.2em] text-brand-blue">
                {item.no} —
              </p>
              <h3 className="text-lg font-semibold">{item.title}</h3>
              <p className="text-sm text-muted-foreground">{item.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ——— Features: real capabilities only ——— */}
      <section
        aria-labelledby="features-heading"
        className="mx-auto w-full max-w-6xl"
      >
        <p className="text-xs font-semibold tracking-[0.25em] text-brand-blue uppercase">
          What&apos;s inside
        </p>
        <h2
          id="features-heading"
          className="mt-3 max-w-2xl text-3xl font-extrabold tracking-tight uppercase sm:text-4xl lg:text-5xl leading-[1.02]"
        >
          Everything a <span className="text-gradient-brand">study room</span>{" "}
          needs.
        </h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <article
              key={feature.title}
              className="flex flex-col gap-3 rounded-2xl border bg-card p-5 sm:p-6"
            >
              <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-brand-soft text-brand-blue">
                <feature.icon className="size-5" aria-hidden="true" />
              </span>
              <h3 className="font-semibold">{feature.title}</h3>
              <p className="text-sm text-muted-foreground">{feature.body}</p>
            </article>
          ))}
          {/* AI is the marquee capability: a wide card so the three-column
              grid resolves deliberately instead of orphaning a seventh item. */}
          <article className="flex flex-col gap-3 rounded-2xl border bg-gradient-brand-soft p-5 sm:col-span-2 sm:p-6 lg:col-span-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-background text-brand-blue">
              <Sparkles className="size-5" aria-hidden="true" />
            </span>
            <h3 className="font-semibold">AI study assistance</h3>
            <p className="text-sm text-muted-foreground">
              Ask questions about your indexed documents and get answers
              grounded in your own notes — where the room has AI enabled.
            </p>
          </article>
        </div>
      </section>

      {/* ——— Closing CTA ——— */}
      <section className="mx-auto w-full max-w-6xl">
        <div className="flex flex-col items-center rounded-3xl border bg-gradient-brand-soft p-8 text-center sm:p-12">
          <h2 className="max-w-2xl text-3xl font-extrabold tracking-tight uppercase sm:text-4xl lg:text-5xl leading-[1.05]">
            Your next focused{" "}
            <span className="text-gradient-brand">session</span> starts here.
          </h2>
          <p className="mt-4 max-w-md text-muted-foreground">
            Create an alias, find a public room on your exam track, or open
            your own and invite the people you study with.
          </p>
          <Button
            asChild
            size="lg"
            className="mt-7 rounded-full bg-gradient-brand text-white hover:bg-gradient-brand hover:brightness-110"
          >
            <Link href="/auth/sign-up">Join SdyRoom</Link>
          </Button>
        </div>
      </section>
    </LandingShell>
  );
}
