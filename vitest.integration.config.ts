import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    name: "integration",
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "**/.next/**", "**/dist/**"],
    setupFiles: ["./tests/integration/setup-env.ts"],
    clearMocks: true,
    // One local database, shared fixtures and admin SQL: files must not
    // interleave or an assertion about "no rows" could observe another file.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
