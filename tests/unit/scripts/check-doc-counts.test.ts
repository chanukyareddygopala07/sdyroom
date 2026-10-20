import { readFileSync } from "node:fs";
import path from "node:path";
import {
  aggregateVitestJson,
  compareCount,
  formatReadmeSuiteLine,
  mentionsFile,
  parsePlaywrightList,
  parseReadmeSuiteLine,
  parseSecurityCoverage,
  runChecks,
} from "../../../scripts/check-doc-counts.mjs";
import { describe, expect, it } from "vitest";

const README_LINE = `Current suite: **1559 unit** (138 files), **430 integration** (24 files), **78 e2e**
(20 specs).`;

const FULL_OBSERVED = {
  unitFiles: 138,
  unitTests: 1559,
  integrationFiles: 24,
  integrationFileList: ["tests/integration/notifications.test.ts"],
  integrationTests: 430,
  integrationTestFiles: { "tests/integration/notifications.test.ts": 23 },
  e2eTests: 78,
  e2eSpecs: 20,
  e2eFiles: { "notifications.spec.ts": 3 },
  e2eFileList: ["tests/e2e/notifications.spec.ts"],
};

function check(overrides: Record<string, unknown>, extra?: Record<string, unknown>) {
  return runChecks({
    readmeMd: `See below.\n\n${README_LINE}\n`,
    securityMd: "Coverage table: `tests/integration/notifications.test.ts` (23) and `tests/e2e/notifications.spec.ts` (3).",
    integrationReadmeMd: "| File | What it proves |\n| --- | --- |\n| `notifications.test.ts` | rows and jobs |",
    e2eReadmeMd: "| File | What it proves |\n| --- | --- |\n| `notifications.spec.ts` | flows |",
    observed: { ...FULL_OBSERVED, ...overrides },
    ...(extra ?? {}),
  });
}

describe("parseReadmeSuiteLine", () => {
  it("parses the repository's wrapped Current suite line", () => {
    expect(parseReadmeSuiteLine(README_LINE)).toEqual({
      unitTests: 1559,
      unitFiles: 138,
      integrationTests: 430,
      integrationFiles: 24,
      e2eTests: 78,
      e2eSpecs: 20,
    });
  });

  it("returns null when the line has been rewritten beyond recognition", () => {
    expect(parseReadmeSuiteLine("lots of unit tests, many files")).toBeNull();
    expect(parseReadmeSuiteLine("")).toBeNull();
  });

  it("round-trips through formatReadmeSuiteLine", () => {
    const parsed = parseReadmeSuiteLine(README_LINE);
    expect(parsed).not.toBeNull();
    expect(formatReadmeSuiteLine(parsed!)).toBe(README_LINE);
  });
});

describe("parseSecurityCoverage", () => {
  it("extracts written (N) counts for integration and e2e files", () => {
    const md = "`tests/integration/notifications.test.ts` (23), `tests/e2e/notifications.spec.ts` (3)";
    expect(parseSecurityCoverage(md)).toEqual([
      { file: "tests/integration/notifications.test.ts", suite: "integration", count: 23 },
      { file: "tests/e2e/notifications.spec.ts", suite: "e2e", count: 3 },
    ]);
  });

  it("ignores numbers that are not in the backticked file (N) form", () => {
    const md = "19 migrations, 430 tests, (22) an aside";
    expect(parseSecurityCoverage(md)).toEqual([]);
  });

  it("reads the real docs/SECURITY.md coverage numbers", () => {
    const entries = parseSecurityCoverage(readFileSync(path.resolve("docs/SECURITY.md"), "utf8"));
    expect(entries.length).toBeGreaterThan(20);
    expect(entries.filter((e) => e.suite === "e2e").length).toBe(12);
    expect(entries.filter((e) => e.suite === "integration").length).toBe(12);
  });
});

describe("aggregateVitestJson", () => {
  it("sums numTotalTests and per-file assertion counts", () => {
    const json = {
      numTotalTests: 37,
      testResults: [
        { name: path.resolve("tests/integration/a.test.ts"), assertionResults: [{}, {}, {}] },
        { name: path.resolve("tests/integration/b.test.ts"), assertionResults: [{}, {}] },
      ],
    };
    expect(aggregateVitestJson(json)).toEqual({
      tests: 37,
      files: { "tests/integration/a.test.ts": 3, "tests/integration/b.test.ts": 2 },
    });
  });
});

describe("parsePlaywrightList", () => {
  const output = `Listing tests:
  [chromium] › resources.spec.ts:10:7 › a
  [chromium] › resources.spec.ts:20:7 › b
  [chromium] › responsive-a11y.spec.ts:5:7 › c
Total: 3 tests in 2 files`;

  it("reads totals from the footer and counts per spec prefix", () => {
    const parsed = parsePlaywrightList(output);
    expect(parsed.tests).toBe(3);
    expect(parsed.specs).toBe(2);
    expect(parsed.files).toEqual({
      "resources.spec.ts": 2,
      "responsive-a11y.spec.ts": 1,
    });
  });

  it("handles filenames that contain digits", () => {
    expect((parsePlaywrightList(output).files as Record<string, number>)["responsive-a11y.spec.ts"]).toBe(1);
  });
});

describe("compareCount and mentionsFile", () => {
  it("reports drift with docs vs repository wording", () => {
    expect(compareCount("README unit file count", 138, 140)).toBe(
      "README unit file count: docs say 138, repository has 140",
    );
    expect(compareCount("README unit file count", 138, 138)).toBeNull();
  });

  it("matches a README row by backticked basename or full path", () => {
    expect(mentionsFile("| `notifications.test.ts` | rows |", "tests/integration/notifications.test.ts")).toBe(true);
    expect(mentionsFile("| `tests/integration/notifications.test.ts` | rows |", "tests/integration/notifications.test.ts")).toBe(true);
    expect(mentionsFile("| `analytics.test.ts` | other |", "tests/integration/notifications.test.ts")).toBe(false);
  });
});

describe("runChecks", () => {
  it("passes when the documents and the repository agree", () => {
    expect(runChecks({
      readmeMd: README_LINE,
      securityMd: "`tests/integration/notifications.test.ts` (23), `tests/e2e/notifications.spec.ts` (3)",
      integrationReadmeMd: "`notifications.test.ts`",
      e2eReadmeMd: "`notifications.spec.ts`",
      observed: FULL_OBSERVED,
    }).problems).toEqual([]);
  });

  it("flags every drifted README number", () => {
    const { problems } = check({
      unitFiles: 139,
      unitTests: 1600,
      e2eTests: 80,
      e2eSpecs: 21,
      integrationTests: 431,
      integrationFiles: 25,
    });
    expect(problems).toHaveLength(6);
    expect(problems[0]).toContain("README unit file count: docs say 138, repository has 139");
    expect(problems).toContain("README unit test count: docs say 1559, repository has 1600");
  });

  it("flags a stale SECURITY count when the run source is available", () => {
    const { problems, skipped } = runChecks({
      readmeMd: README_LINE,
      securityMd: "`tests/integration/notifications.test.ts` (24)",
      integrationReadmeMd: "`notifications.test.ts`",
      e2eReadmeMd: "`notifications.spec.ts`",
      observed: FULL_OBSERVED,
    });
    expect(problems).toEqual([
      "docs/SECURITY.md tests/integration/notifications.test.ts: docs say 24, repository has 23",
    ]);
    expect(skipped).toEqual([]);
  });

  it("skips (never fails) totals when the suite json was not supplied", () => {
    const { problems, skipped } = check({ unitTests: null, integrationTests: null, integrationTestFiles: null });
    expect(problems).toEqual([]);
    expect(skipped).toEqual(
      expect.arrayContaining([
        expect.stringContaining("README unit test count"),
        expect.stringContaining("README integration test count"),
        expect.stringContaining("integration json not supplied"),
      ]),
    );
  });

  it("fails on an e2e SECURITY entry that matches no spec at all", () => {
    const { problems } = runChecks({
      readmeMd: README_LINE,
      securityMd: "`tests/e2e/ghost.spec.ts` (3)",
      integrationReadmeMd: "`notifications.test.ts`",
      e2eReadmeMd: "`notifications.spec.ts`",
      observed: FULL_OBSERVED,
    });
    expect(problems).toEqual([
      "docs/SECURITY.md: e2e entry tests/e2e/ghost.spec.ts (3) matches no spec in playwright --list",
    ]);
  });

  it("reports README rows missing for test files on disk", () => {
    const { problems } = runChecks({
      readmeMd: README_LINE,
      securityMd: "",
      integrationReadmeMd: "| `notifications.test.ts` | ok |",
      e2eReadmeMd: "| `notifications.spec.ts` | ok |",
      observed: {
        ...FULL_OBSERVED,
        integrationFileList: ["tests/integration/notifications.test.ts", "tests/integration/fresh.test.ts"],
        e2eFileList: ["tests/e2e/notifications.spec.ts", "tests/e2e/fresh.spec.ts"],
      },
    });
    expect(problems).toEqual([
      "tests/integration/README.md: no row for tests/integration/fresh.test.ts",
      "tests/e2e/README.md: no row for tests/e2e/fresh.spec.ts",
    ]);
  });

  it("fails loudly when the Current suite line vanished from README", () => {
    const { problems } = runChecks({
      readmeMd: "no counts here anymore",
      securityMd: "",
      integrationReadmeMd: "",
      e2eReadmeMd: "",
      observed: FULL_OBSERVED,
    });
    expect(problems[0]).toContain("could not find the 'Current suite:' line");
  });
});
