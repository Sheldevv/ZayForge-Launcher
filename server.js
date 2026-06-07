require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const PORT = process.env.API_PORT || 3131;
const JWT_SECRET =
  process.env.JWT_SECRET || "zayforge-jwt-secret-change-in-production-2026";
const SALT_ROUNDS = 10;

const app = express();

// ── Middleware ────────────────────────────────────────
app.use(
  cors({
    origin: "*",
    methods: "GET,POST,PATCH,DELETE,OPTIONS",
    allowedHeaders: "Content-Type,Authorization",
  }),
);

// Raw body parser for avatar upload
app.use(
  "/api/auth/me/avatar",
  express.raw({ type: "image/png", limit: "10kb" }),
);
// JSON for everything else
app.use(express.json({ limit: "1mb" }));

// ── Database ─────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Test connection on startup
pool
  .query("SELECT 1")
  .then(() => {
    console.log("[ZayForge API] PostgreSQL connected");
  })
  .catch((err) => {
    console.error("[ZayForge API] PostgreSQL connection failed:", err.message);
  });

// ── Helpers ──────────────────────────────────────────

function ok(data) {
  return { ok: true, ...data };
}

function err(message, status = 400) {
  return { error: message, ok: false, _status: status };
}

function generateId() {
  return crypto.randomUUID();
}

function signToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      email: user.email,
      avatar: user.avatar,
    },
    JWT_SECRET,
    { expiresIn: "30d" },
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function getToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

async function requireAuth(req, res) {
  const token = getToken(req);
  if (!token) {
    res.status(401).json(err("Authentication required", 401));
    return null;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json(err("Invalid or expired token", 401));
    return null;
  }

  // Verify user still exists
  const result = await pool.query(
    'SELECT id, username, email, avatar FROM "User" WHERE id = $1',
    [payload.userId],
  );
  if (result.rows.length === 0) {
    res.status(401).json(err("User not found", 401));
    return null;
  }
  return result.rows[0];
}

function userToResponse(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatar: user.avatar || null,
    createdAt: user.createdAt || user.createdat,
  };
}

// ── GET /api/ping ─────────────────────────────────────
app.get("/api/ping", async (req, res) => {
  res.json(
    ok({
      ping: "pong",
      name: "ZayForge API",
      version: "1.0.0",
      time: new Date().toISOString(),
    }),
  );
});

// ── POST /api/auth/register ──────────────────────────
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || typeof username !== "string") {
      return res.status(400).json(err("username is required", 400));
    }
    if (username.length < 3) {
      return res
        .status(400)
        .json(err("Username must be at least 3 characters", 400));
    }
    if (username.length > 20) {
      return res
        .status(400)
        .json(err("Username must be at most 20 characters", 400));
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res
        .status(400)
        .json(
          err(
            "Username can only contain letters, numbers, and underscores",
            400,
          ),
        );
    }
    if (!email || typeof email !== "string") {
      return res.status(400).json(err("Email is required", 400));
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json(err("Invalid email address", 400));
    }
    if (!password || password.length < 6) {
      return res
        .status(400)
        .json(err("Password must be at least 6 characters", 400));
    }

    // Check existing
    const existing = await pool.query(
      'SELECT id FROM "User" WHERE email = $1 OR username = $2',
      [email, username],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      // We'd need to check which one, but the API returns email-first
      return res
        .status(409)
        .json(err("A user with that email already exists", 409));
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const id = generateId();
    const now = new Date().toISOString();

    const result = await pool.query(
      `INSERT INTO "User" (id, username, email, password, avatar, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, NULL, $5, $5)
       RETURNING id, username, email, avatar, "createdAt"`,
      [id, username, email, hashedPassword, now],
    );

    const user = result.rows[0];
    const token = signToken(user);

    res.status(200).json(
      ok({
        user: userToResponse(user),
        token,
      }),
    );
  } catch (e) {
    console.error("Register error:", e);
    if (e.code === "23505") {
      if (e.constraint && e.constraint.includes("email")) {
        return res
          .status(409)
          .json(err("A user with that email already exists", 409));
      }
      return res.status(409).json(err("Username already taken", 409));
    }
    res.status(500).json(err("Internal server error", 500));
  }
});

// ── POST /api/auth/login ─────────────────────────────
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json(err("Email and password are required", 400));
    }

    const result = await pool.query(
      'SELECT id, username, email, password, avatar, "createdAt" FROM "User" WHERE email = $1',
      [email],
    );
    if (result.rows.length === 0) {
      return res.status(401).json(err("Invalid email or password", 401));
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json(err("Invalid email or password", 401));
    }

    const token = signToken(user);

    res.status(200).json(
      ok({
        user: userToResponse(user),
        token,
      }),
    );
  } catch (e) {
    console.error("Login error:", e);
    res.status(500).json(err("Internal server error. Check server logs.", 500));
  }
});

// ── GET /api/auth/me ──────────────────────────────────
app.get("/api/auth/me", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  res.json(ok({ user: userToResponse(user) }));
});

// ── PATCH /api/auth/me ────────────────────────────────
app.patch("/api/auth/me", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    const { username } = req.body;

    if (!username || typeof username !== "string") {
      return res.status(400).json(err("username is required", 400));
    }
    if (username.length < 3) {
      return res
        .status(400)
        .json(err("Username must be at least 3 characters", 400));
    }
    if (username.length > 20) {
      return res
        .status(400)
        .json(err("Username must be at most 20 characters", 400));
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res
        .status(400)
        .json(
          err(
            "Username can only contain letters, numbers, and underscores",
            400,
          ),
        );
    }

    // Check uniqueness
    const existing = await pool.query(
      'SELECT id FROM "User" WHERE username = $1 AND id != $2',
      [username, user.id],
    );
    if (existing.rows.length > 0) {
      return res.status(409).json(err("Username already taken", 409));
    }

    const result = await pool.query(
      `UPDATE "User" SET username = $1, "updatedAt" = $2 WHERE id = $3
       RETURNING id, username, email, avatar, "createdAt"`,
      [username, new Date().toISOString(), user.id],
    );

    res.json(ok({ user: userToResponse(result.rows[0]) }));
  } catch (e) {
    console.error("PATCH /me error:", e);
    res.status(500).json(err("Failed to update profile", 500));
  }
});

// ── DELETE /api/auth/me ───────────────────────────────
app.delete("/api/auth/me", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    await pool.query('DELETE FROM "User" WHERE id = $1', [user.id]);
    res.json(ok({ deleted: true }));
  } catch (e) {
    console.error("DELETE /me error:", e);
    res.status(500).json(err("Failed to delete account", 500));
  }
});

// ── POST /api/auth/logout ─────────────────────────────
app.post("/api/auth/logout", (req, res) => {
  // No-op for token-based auth (client discards token)
  res.json(ok({ success: true }));
});

// ── POST /api/auth/me/avatar ──────────────────────────
app.post(
  "/api/auth/me/avatar",
  express.raw({ type: "image/png", limit: "10kb" }),
  async (req, res) => {
    // Manually extract token since body is raw
    const token = getToken(req);
    if (!token)
      return res.status(401).json(err("Authentication required", 401));

    const payload = verifyToken(token);
    if (!payload)
      return res.status(401).json(err("Invalid or expired token", 401));

    const userCheck = await pool.query('SELECT id FROM "User" WHERE id = $1', [
      payload.userId,
    ]);
    if (userCheck.rows.length === 0)
      return res.status(401).json(err("User not found", 401));

    try {
      const buffer = req.body;
      if (!buffer || buffer.length === 0) {
        return res.status(400).json(err("Empty file", 400));
      }
      if (buffer.length > 4096) {
        return res.status(400).json(err("Image too large (max 4 KB)", 400));
      }

      // Validate PNG signature
      const pngSig = [137, 80, 78, 71, 13, 10, 26, 10];
      for (let i = 0; i < 8; i++) {
        if (buffer[i] !== pngSig[i]) {
          return res.status(400).json(err("File must be a valid PNG", 400));
        }
      }

      // Validate 16x16 dimensions
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      if (width !== 16 || height !== 16) {
        return res
          .status(400)
          .json(
            err(
              `Avatar must be exactly 16×16 pixels (got ${width}×${height})`,
              400,
            ),
          );
      }

      const base64 = buffer.toString("base64");
      const dataUrl = `data:image/png;base64,${base64}`;

      const result = await pool.query(
        `UPDATE "User" SET avatar = $1, "updatedAt" = $2 WHERE id = $3
       RETURNING id, username, email, avatar, "createdAt"`,
        [dataUrl, new Date().toISOString(), payload.userId],
      );

      res.json(ok({ user: userToResponse(result.rows[0]) }));
    } catch (e) {
      console.error("Avatar upload error:", e);
      res.status(500).json(err("Failed to upload avatar", 500));
    }
  },
);

// ── DELETE /api/auth/me/avatar ────────────────────────
app.delete("/api/auth/me/avatar", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    const result = await pool.query(
      `UPDATE "User" SET avatar = NULL, "updatedAt" = $1 WHERE id = $2
       RETURNING id, username, email, avatar, "createdAt"`,
      [new Date().toISOString(), user.id],
    );
    res.json(ok({ user: userToResponse(result.rows[0]) }));
  } catch (e) {
    console.error("Avatar delete error:", e);
    res.status(500).json(err("Failed to remove avatar", 500));
  }
});

// ── POST /api/game/save ───────────────────────────────
app.post("/api/game/save", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    const { slot, name, data, playTime, version } = req.body;

    if (
      slot === undefined ||
      slot === null ||
      typeof slot !== "number" ||
      slot < 0 ||
      slot > 9
    ) {
      return res.status(400).json(err("slot must be a number 0-9", 400));
    }
    if (!data) {
      return res.status(400).json(err("data is required", 400));
    }

    const now = new Date().toISOString();
    const dataStr = typeof data === "string" ? data : JSON.stringify(data);

    const result = await pool.query(
      `INSERT INTO "GameSave" (id, "userId", slot, name, data, version, "playTime", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT ("userId", slot)
       DO UPDATE SET name = $4, data = $5, version = $6, "playTime" = $7, "updatedAt" = $8
       RETURNING id, slot, name, version, "playTime", "updatedAt"`,
      [
        generateId(),
        user.id,
        slot,
        name || "Save",
        dataStr,
        version || "1.0",
        playTime || 0,
        now,
      ],
    );

    res.json(ok({ save: result.rows[0] }));
  } catch (e) {
    console.error("Save error:", e);
    res.status(500).json(err("Failed to save game", 500));
  }
});

// ── GET /api/game/load ────────────────────────────────
app.get("/api/game/load", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    const slot =
      req.query.slot !== undefined ? parseInt(req.query.slot, 10) : null;

    let result;
    if (slot !== null) {
      result = await pool.query(
        'SELECT id, slot, name, data, version, "playTime", "updatedAt" FROM "GameSave" WHERE "userId" = $1 AND slot = $2 ORDER BY "updatedAt" DESC',
        [user.id, slot],
      );
    } else {
      result = await pool.query(
        'SELECT id, slot, name, data, version, "playTime", "updatedAt" FROM "GameSave" WHERE "userId" = $1 ORDER BY slot ASC',
        [user.id],
      );
    }

    res.json(ok({ saves: result.rows }));
  } catch (e) {
    console.error("Load error:", e);
    res.status(500).json(err("Failed to load saves", 500));
  }
});

// ── DELETE /api/game/saves ────────────────────────────
app.delete("/api/game/saves", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    const slot =
      req.query.slot !== undefined ? parseInt(req.query.slot, 10) : null;
    if (slot === null) {
      return res.status(400).json(err("slot query parameter required", 400));
    }

    await pool.query(
      'DELETE FROM "GameSave" WHERE "userId" = $1 AND slot = $2',
      [user.id, slot],
    );
    res.json(ok({ deleted: true, slot }));
  } catch (e) {
    console.error("Delete save error:", e);
    res.status(500).json(err("Failed to delete save", 500));
  }
});

// ── Start ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[ZayForge API] Server running on http://localhost:${PORT}`);
});
