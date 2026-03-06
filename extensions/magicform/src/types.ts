/**
 * Type definitions for the MagicForm channel plugin.
 */

/** Raw channel config from openclaw.json channels.magicform */
export interface MagicFormChannelConfig {
  enabled?: boolean;
  backendUrl?: string;
  apiToken?: string;
  callbackPath?: string;
  callbackUrl?: string;
  webhookPath?: string;
  dmPolicy?: "open" | "allowlist" | "disabled";
  allowFrom?: string[];
  rateLimitPerMinute?: number;
  accounts?: Record<string, MagicFormAccountRaw>;
}

/** Raw per-account config (overrides base config) */
export interface MagicFormAccountRaw {
  enabled?: boolean;
  backendUrl?: string;
  apiToken?: string;
  callbackPath?: string;
  callbackUrl?: string;
  webhookPath?: string;
  dmPolicy?: "open" | "allowlist" | "disabled";
  allowFrom?: string[];
  rateLimitPerMinute?: number;
}

/** Fully resolved account config with defaults applied */
export interface ResolvedMagicFormAccount {
  accountId: string;
  enabled: boolean;
  backendUrl: string;
  apiToken: string;
  callbackPath: string;
  callbackUrl: string;
  webhookPath: string;
  dmPolicy: "open" | "allowlist" | "disabled";
  allowFrom: string[];
  rateLimitPerMinute: number;
}

/** Inbound webhook payload — SendTaskRequest (MagicForm → OpenClaw) */
export interface MagicFormWebhookPayload {
  message: string;
  stackId: string;
  conversationId: string;
  userId?: string;
  /** Workspace directory for agent-generated files. */
  workspace?: string;
  /** Directory containing openclaw.json overlay + bootstrap .md files. */
  configDir?: string;
  /** Full callback URL (overrides config default). */
  callbackUrl?: string;
  /** Tool allowlist override. */
  allowedTools?: string[];
  /** Skill filter (only load these skills for this session). */
  allowedSkills?: string[];
}

/** Token usage details for a callback. */
export interface MagicFormTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  provider: string;
}

/** Progress details for in-flight callbacks. */
export interface MagicFormProgress {
  status: string;
  toolName?: string;
  stepNumber?: number;
  message?: string;
}

/** Escalation details when agent needs human intervention. */
export interface MagicFormEscalation {
  reason: string;
  notes?: string;
}

/** Outbound callback payload — CallbackPayload (OpenClaw → MagicForm) */
export interface MagicFormCallbackPayload {
  stackId: string;
  conversationId: string;
  taskId: string;
  type: "final" | "progress" | "escalation";
  status: "success" | "error";
  response: string | null;
  error: string | null;
  runtime: string;
  durationMs: number | null;
  tokenUsage: MagicFormTokenUsage | null;
  toolCalls: number | null;
  progress: MagicFormProgress | null;
  escalation: MagicFormEscalation | null;
}
