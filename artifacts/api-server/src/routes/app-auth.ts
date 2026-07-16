import "../lib/session";

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";

const router: IRouter = Router();

const loginLimiter = rateLimit({
  windowMs:               15 * 60 * 1000,
  max:                    10,
  standardHeaders:        true,
  legacyHeaders:          false,
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts. Please try again later." },
});

router.post("/auth/app/login", loginLimiter, (req: Request, res: Response): void => {
  const { password } = req.body ?? {};

  if (typeof password !== "string" || password !== process.env["APP_ACCESS_PASSWORD"]) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  req.session.appAuthenticated = true;
  req.session.save((err) => {
    if (err) {
      res.status(500).json({ error: "Session error" });
      return;
    }
    res.json({ authenticated: true });
  });
});

router.post("/auth/app/logout", (req: Request, res: Response): void => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: "Logout failed" });
      return;
    }
    res.clearCookie("zeit.sid");
    res.json({ authenticated: false });
  });
});

router.get("/auth/app/me", (req: Request, res: Response): void => {
  if (req.session.appAuthenticated) {
    res.json({ authenticated: true });
  } else {
    res.status(401).json({ authenticated: false });
  }
});

const PUBLIC_EXACT = new Set([
  "/healthz",
  "/auth/app/login",
  "/auth/app/logout",
  "/auth/app/me",
]);

export function requireAppAuth(req: Request, res: Response, next: NextFunction): void {
  const path = req.path;

  if (PUBLIC_EXACT.has(path) || path.startsWith("/auth/employee/") || path.startsWith("/employee-timesheet/")) {
    next();
    return;
  }

  if (req.session.appAuthenticated) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

export default router;
