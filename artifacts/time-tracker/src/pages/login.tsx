import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useSetAuthenticated, useAppAuth } from "@/hooks/use-app-auth";

export default function Login() {
  const [, navigate] = useLocation();
  const auth = useAppAuth();
  const setAuthenticated = useSetAuthenticated();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (auth === "authenticated") navigate("/dashboard");
  }, [auth, navigate]);

  if (auth === "loading" || auth === "authenticated") return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/app/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setAuthenticated();
        navigate("/dashboard");
      } else {
        const body = await res.json().catch(() => ({}));
        setError(res.status === 429 ? "Too many attempts. Please wait before trying again." : (body.error ?? "Invalid password"));
        setPassword("");
      }
    } catch {
      setError("Connection error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold tracking-tight gradient-text">AvaTrack</h1>
          <p className="text-xs text-muted-foreground">Internal access only</p>
        </div>
        <div className="bg-card border border-border rounded-lg shadow-xs p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="password" className="text-xs font-medium text-foreground">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
                autoComplete="current-password"
                className="w-full h-8 px-2.5 rounded-md border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:border-[#8B5CF6] focus:ring-[3px] focus:ring-[rgba(139,92,246,0.12)] disabled:opacity-50 transition-shadow"
                placeholder="Enter access password"
              />
            </div>
            {error && <p className="text-xs text-destructive font-medium">{error}</p>}
            <button
              type="submit"
              disabled={loading || !password}
              className="w-full h-8 px-3 rounded-md text-white text-xs font-medium focus:outline-none focus:ring-2 focus:ring-[#8B5CF6] focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:brightness-110 active:brightness-95"
              style={{ background: "var(--gradient-brand)" }}
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
