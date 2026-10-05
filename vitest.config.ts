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
  },
});
