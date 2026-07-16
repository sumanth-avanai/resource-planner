/**
 * Mock-mode Vite config — used only by `pnpm dev:mock`.
 *
 * Provides sensible defaults for the env vars the main config requires
 * (PORT/BASE_PATH) and turns on VITE_MOCK so the app serves all /api/*
 * requests from src/mocks/db.json. The real vite.config.ts is reused
 * untouched.
 */
process.env.PORT = process.env.PORT || "5173";
process.env.BASE_PATH = process.env.BASE_PATH || "/";
process.env.VITE_MOCK = "1";

const config = (await import("./vite.config")).default;

export default config;
  