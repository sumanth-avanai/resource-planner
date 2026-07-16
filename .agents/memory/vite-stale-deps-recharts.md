---
name: Vite stale deps cache & Invalid hook call
description: Clearing the Vite pre-bundled deps cache fixes "Invalid hook call" runtime crashes that appear after adding a new library (e.g. recharts) to a page.
---

## Rule
When a new npm package that bundles its own React-calling code is added (e.g. recharts, other UI libs), Vite's existing pre-bundled deps cache may become stale. The stale bundle can reference a different React module instance than the main app, triggering React's "Invalid hook call" error at runtime. This cascades: the broken render leaves React's dispatcher in a corrupted state, so subsequent pages crash with `.map is not a function` or `.filter is not a function` on data that's actually a `Set` or other non-array from a previous component's state slot.

**Fix:** Delete the Vite deps cache and restart:
```bash
rm -rf artifacts/time-tracker/node_modules/.vite/
```
Then restart the `Start application` workflow. Vite re-optimises all deps fresh.

**Why:** Vite pre-bundles node_modules deps into `node_modules/.vite/deps/`. If you add a package that internally calls React (like recharts) to a file for the first time, Vite may not re-bundle it if the cache timestamp looks fresh. The stale bundle imports a different copy of React than the one deduplicated by `dedupe: ["react", "react-dom"]`, causing multiple React instances → "Invalid hook call".

**How to apply:** Any time you see "Invalid hook call" in the Vite dev server after adding a new React-using library, clear the cache before investigating code-level hook ordering issues.
