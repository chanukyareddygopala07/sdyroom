import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    name: "unit",
    environment: "node",
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/.next/**",
      "**/dist/**",
      "**/coverage/**",
      "tests/integration/**",
    ],
    setupFiles: ["./tests/setup.ts"],
    clearMocks: true,
    // PR 21: coverage measures the server-side surface only — lib/ and the
    // API routes. UI components are covered by the unit suites' behavioural
    // assertions but are deliberately outside the numeric floor (the numbers
    // would drown real server-code regressions). Integration tests run
    // against the real stack under a separate config and are never folded
    // into this figure; the rule is documented in docs/DEVELOPMENT.md.
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["lib/**/*.ts", "app/api/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/types.ts",
        "next-env.d.ts",
        "**/__mocks__/**",
        "**/mocks/**",
        "**/test-utils.ts",
      ],
      // Live-meetings floors: measured baseline on 2026-10-21 was 76.04%
      // statements / 66.66% branches; floor = baseline − 1pp, rounded down,
      // so coverage cannot regress silently (the prior PR 21 baseline was
      // 75.5 / 65.95 → floors 74 / 64). Ratchet upward in later PRs — never
      // lower these numbers without a written reason in the PR description.
      thresholds: {
        statements: 75,
        branches: 65,
      },
    },
  },
});
