import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ErrorCode, type AppEnv } from "../types/index.js";

export function errorResponse(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  details: unknown = null
) {
  return c.json({ success: false as const, error: { code, message, details } }, status);
}

export function notFoundResponse(c: Context<AppEnv>, message: string) {
  return errorResponse(c, 404, ErrorCode.NOT_FOUND, message);
}

export function validationErrorResponse(c: Context<AppEnv>, message: string, details: unknown = null) {
  return errorResponse(c, 422, ErrorCode.VALIDATION_ERROR, message, details);
}

export function forbiddenResponse(c: Context<AppEnv>, message: string) {
  return errorResponse(c, 403, ErrorCode.FORBIDDEN, message);
}
