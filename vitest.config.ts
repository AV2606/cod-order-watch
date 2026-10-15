import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: that file loads the React Router plugin,
// which isn't needed (and gets in the way) for plain unit tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
