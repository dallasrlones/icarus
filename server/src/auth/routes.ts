import { Router, type Request, type Response } from "express";
import { signToken } from "./jwt.js";
import {
  AuthError,
  changePassword,
  getUserById,
  loginUser,
} from "./service.js";

export const authRouter: Router = Router();

function handleError(err: unknown, res: Response): void {
  if (err instanceof AuthError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  const message = err instanceof Error ? err.message : "internal error";
  console.error(`[auth] ${message}`);
  res.status(500).json({ error: "internal error" });
}

authRouter.post("/login", async (req: Request, res: Response) => {
  try {
    const username = String(req.body?.username ?? "");
    const password = String(req.body?.password ?? "");
    const { user } = await loginUser(username, password);
    const token = signToken({
      sub: user.id,
      username: user.username,
      must_change_password: user.must_change_password,
    });
    res.json({ token, user });
  } catch (err) {
    handleError(err, res);
  }
});

authRouter.get("/me", async (req: Request, res: Response) => {
  if (!req.auth) {
    res.status(401).json({ error: "unauthenticated", code: "unauthenticated" });
    return;
  }
  const user = await getUserById(req.auth.user.id);
  if (!user) {
    res.status(401).json({ error: "user no longer exists", code: "user_missing" });
    return;
  }
  res.json({ user });
});

authRouter.post("/logout", (_req: Request, res: Response) => {
  // Stateless JWT — logout is purely client-side (drop the token).
  // Echo `ok` for symmetry with login so clients can `await` it.
  res.json({ ok: true });
});

authRouter.post("/change-password", async (req: Request, res: Response) => {
  if (!req.auth) {
    res.status(401).json({ error: "unauthenticated", code: "unauthenticated" });
    return;
  }
  try {
    const current = String(req.body?.current_password ?? "");
    const next = String(req.body?.new_password ?? "");
    const user = await changePassword(req.auth.user.id, current, next);
    // Re-issue token so the new `must_change_password=false` claim
    // takes effect immediately without a fresh login round-trip.
    const token = signToken({
      sub: user.id,
      username: user.username,
      must_change_password: user.must_change_password,
    });
    res.json({ token, user });
  } catch (err) {
    handleError(err, res);
  }
});
