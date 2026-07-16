import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import pinoHttp from "pino-http";
import "./lib/session";
import router from "./routes";
import { requireAppAuth } from "./routes/app-auth";
import { logger } from "./lib/logger";

if (!process.env["APP_ACCESS_PASSWORD"]) {
  logger.fatal("APP_ACCESS_PASSWORD environment variable is not set.");
  process.exit(1);
}

if (!process.env["SESSION_SECRET"]) {
  logger.fatal("SESSION_SECRET environment variable is not set.");
  process.exit(1);
}

const app: Express = express();

app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

const ALLOWED_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /\.replit\.dev$/,
  /\.replit\.app$/,
  /\.repl\.co$/,
];

app.use(cors({
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }
    const allowed = ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
    callback(allowed ? null : new Error("CORS: origin not allowed"), allowed);
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    name:              "zeit.sid",
    secret:            process.env["SESSION_SECRET"]!,
    resave:            false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure:   process.env["NODE_ENV"] === "production",
      sameSite: "lax",
      maxAge:   7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use("/api", requireAppAuth, router);

export default app;
