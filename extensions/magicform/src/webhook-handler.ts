/**
 * Inbound webhook handler for MagicForm.
 * Parses JSON body, validates token, delivers to agent, sends callback.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/magicform";
import { sendCallback } from "./client.js";
import { validateToken, authorizeStackId, sanitizeInput, RateLimiter } from "./security.js";
import type { ResolvedMagicFormAccount, MagicFormWebhookPayload } from "./types.js";

const rateLimiters = new Map<string, RateLimiter>();

function getRateLimiter(account: ResolvedMagicFormAccount): RateLimiter {
  let rl = rateLimiters.get(account.accountId);
  if (!rl || rl.maxRequests() !== account.rateLimitPerMinute) {
    rl?.clear();
    rl = new RateLimiter(account.rateLimitPerMinute);
    rateLimiters.set(account.accountId, rl);
  }
  return rl;
}

export function clearMagicFormWebhookRateLimiterStateForTest(): void {
  for (const limiter of rateLimiters.values()) {
    limiter.clear();
  }
  rateLimiters.clear();
}

async function readBody(req: IncomingMessage): Promise<
  | { ok: true; body: string }
  | { ok: false; statusCode: number; error: string }
> {
  try {
    const body = await readRequestBodyWithLimit(req, {
      maxBytes: 1_048_576,
      timeoutMs: 30_000,
    });
    return { ok: true, body };
  } catch (err) {
    if (isRequestBodyLimitError(err)) {
      return {
        ok: false,
        statusCode: err.statusCode,
        error: requestBodyErrorToText(err.code),
      };
    }
    return { ok: false, statusCode: 400, error: "Invalid request body" };
  }
}

function extractBearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (!auth) return undefined;
  const headerValue = Array.isArray(auth) ? auth[0] : auth;
  const match = headerValue?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function parsePayload(body: string): MagicFormWebhookPayload | null {
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
  const stackId = typeof parsed.stackId === "string" ? parsed.stackId.trim() : "";
  const conversationId = typeof parsed.conversationId === "string" ? parsed.conversationId.trim() : "";
  const rawUserId = typeof parsed.userId === "string" ? parsed.userId.trim() : "";

  if (!message || !stackId || !conversationId) return null;

  return {
    message,
    stackId,
    conversationId,
    userId: rawUserId || undefined,
    workspace: typeof parsed.workspace === "string" ? parsed.workspace.trim() : undefined,
    configDir: typeof parsed.configDir === "string" ? parsed.configDir.trim() : undefined,
    callbackUrl: typeof parsed.callbackUrl === "string" ? parsed.callbackUrl.trim() : undefined,
    allowedTools: Array.isArray(parsed.allowedTools)
      ? parsed.allowedTools.filter((s: unknown): s is string => typeof s === "string")
      : undefined,
    allowedSkills: Array.isArray(parsed.allowedSkills)
      ? parsed.allowedSkills.filter((s: unknown): s is string => typeof s === "string")
      : undefined,
  };
}

function respondJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface WebhookHandlerDeps {
  account: ResolvedMagicFormAccount;
  deliver: (msg: {
    body: string;
    from: string;
    senderName: string;
    provider: string;
    chatType: string;
    sessionKey: string;
    accountId: string;
    /** Per-request overrides from webhook payload. */
    workspaceOverride?: string;
    configDirOverride?: string;
    toolsAllowOverride?: string[];
    skillFilter?: string[];
    /** Per-request callback URL (overrides account default). */
    callbackUrl?: string;
  }) => Promise<string | null>;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/**
 * Create an HTTP request handler for MagicForm inbound webhooks.
 *
 * This handler:
 * 1. Parses JSON payload
 * 2. Validates Bearer token
 * 3. Checks stackId against allowFrom
 * 4. Rate limits by stackId:conversationId
 * 5. ACKs immediately (202)
 * 6. Delivers to agent asynchronously
 * 7. Sends response back to MagicForm callback
 */
export function createWebhookHandler(deps: WebhookHandlerDeps) {
  const { account, deliver, log } = deps;
  const rateLimiter = getRateLimiter(account);

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const bodyResult = await readBody(req);
    if (!bodyResult.ok) {
      log?.error("Failed to read request body", bodyResult.error);
      respondJson(res, bodyResult.statusCode, { error: bodyResult.error });
      return;
    }

    // Validate Bearer token
    const token = extractBearerToken(req);
    if (!token || !validateToken(token, account.apiToken)) {
      log?.warn(`Invalid token from ${req.socket?.remoteAddress}`);
      respondJson(res, 401, { error: "Unauthorized" });
      return;
    }

    // Parse payload
    let payload: MagicFormWebhookPayload | null = null;
    try {
      payload = parsePayload(bodyResult.body);
    } catch (err) {
      log?.warn("Failed to parse webhook payload", err);
      respondJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (!payload) {
      respondJson(res, 400, { error: "Missing required fields (message, stackId, conversationId)" });
      return;
    }

    // Check stackId against allowFrom
    const auth = authorizeStackId(payload.stackId, account.allowFrom);
    if (!auth.allowed) {
      log?.warn(`Stack ${payload.stackId} not in allowFrom`);
      respondJson(res, 403, { error: "Stack not authorized" });
      return;
    }

    // Rate limit
    const rateLimitKey = `${payload.stackId}:${payload.conversationId}`;
    if (!rateLimiter.check(rateLimitKey)) {
      log?.warn(`Rate limit exceeded for ${rateLimitKey}`);
      respondJson(res, 429, { error: "Rate limit exceeded" });
      return;
    }

    // Sanitize input
    const cleanMessage = sanitizeInput(payload.message);
    if (!cleanMessage) {
      respondJson(res, 202, { ok: true });
      return;
    }

    const preview = cleanMessage.length > 100 ? `${cleanMessage.slice(0, 100)}...` : cleanMessage;
    log?.info(`Message from ${payload.userId ?? "unknown"} (stack: ${payload.stackId}): ${preview}`);

    // ACK immediately
    respondJson(res, 202, { ok: true });

    // Resolve the callback URL: per-request overrides account default.
    const effectiveCallbackUrl = payload.callbackUrl || account.callbackUrl;

    // Deliver to agent asynchronously.
    // The dispatcher's deliver callback (in channel.ts) handles sending responses
    // back to MagicForm via sendCallback. This handler only needs to handle errors.
    const sessionKey = `magicform:${payload.stackId}:${payload.conversationId}`;
    const toField = payload.userId
      ? `${payload.stackId}:${payload.conversationId}:${payload.userId}`
      : `${payload.stackId}:${payload.conversationId}`;

    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Agent response timeout (300s)")), 300_000);
      });

      try {
        await Promise.race([
          deliver({
            body: cleanMessage,
            from: toField,
            senderName: payload.userId ?? "unknown",
            provider: "magicform",
            chatType: "direct",
            sessionKey,
            accountId: account.accountId,
            workspaceOverride: payload.workspace,
            configDirOverride: payload.configDir,
            toolsAllowOverride: payload.allowedTools,
            skillFilter: payload.allowedSkills,
            callbackUrl: effectiveCallbackUrl,
          }),
          timeoutPromise,
        ]);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.error(`Failed to process message for ${payload.conversationId}: ${errMsg}`);
      await sendCallback(effectiveCallbackUrl, {
        stackId: payload.stackId,
        conversationId: payload.conversationId,
        taskId: sessionKey,
        type: "final",
        status: "error",
        response: null,
        error: errMsg,
        runtime: "openclaw",
        durationMs: null,
        tokenUsage: null,
        toolCalls: null,
        progress: null,
        escalation: null,
      }, account.apiToken);
    }
  };
}
