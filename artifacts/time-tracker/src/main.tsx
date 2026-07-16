import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

async function bootstrap() {
  // Mock data mode for local UI/UX work: `pnpm dev:mock` (VITE_MOCK=1).
  // In normal dev/production this branch is dead code and the app talks to
  // the real API exactly as before.
  if (import.meta.env.VITE_MOCK === "1") {
    const { installMockApi } = await import("./mocks/mock-api");
    installMockApi();
  }
  createRoot(document.getElementById("root")!).render(<App />);
}

void bootstrap();
