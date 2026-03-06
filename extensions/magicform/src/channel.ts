/**
 * MagicForm Channel Plugin for OpenClaw.
 *
 * Webhook inbound, HTTP callback outbound, no persistent connection.
 */

import {
  DEFAULT_ACCOUNT_ID,
  setAccountEnabledInConfigSection,
  registerPluginHttpRoute,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/magicform";
import { z } from "zod";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { sendCallback } from "./client.js";
import { getMagicFormRuntime } from "./runtime.js";
import type { ResolvedMagicFormAccount } from "./types.js";
import { createWebhookHandler } from "./webhook-handler.js";

const CHANNEL_ID = "magicform";
const MagicFormConfigSchema = buildChannelConfigSchema(z.object({}).passthrough());

const activeRouteUnregisters = new Map<string, () => void>();

/**
 * Split a MagicForm target field into its parts.
 * Accepts both `stack_id:conversation_id` and `stack_id:conversation_id:user_id`.
 * Only the first two colons are treated as delimiters so that IDs containing
 * colons are handled correctly.
 */
function splitTarget(target: string): [string, string, string | undefined] | null {
  const first = target.indexOf(":");
  if (first === -1) return null;
  const second = target.indexOf(":", first + 1);
  if (second === -1) {
    // Two-part: stack_id:conversation_id
    return [target.slice(0, first), target.slice(first + 1), undefined];
  }
  const userId = target.slice(second + 1);
  return [
    target.slice(0, first),
    target.slice(first + 1, second),
    userId || undefined,
  ];
}

function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const complete = () => {
      onAbort?.();
      resolve();
    };
    if (!signal) {
      complete();
      return;
    }
    if (signal.aborted) {
      complete();
      return;
    }
    signal.addEventListener("abort", complete, { once: true });
  });
}

export function createMagicFormPlugin() {
  return {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: "MagicForm",
      selectionLabel: "MagicForm (Webhook)",
      detailLabel: "MagicForm (Webhook)",
      docsPath: "/channels/magicform",
      blurb: "Connect MagicForm to OpenClaw for agentic task processing.",
      order: 91,
    },

    capabilities: {
      chatTypes: ["direct" as const],
      media: false,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
      blockStreaming: false,
    },

    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

    configSchema: MagicFormConfigSchema,

    config: {
      listAccountIds: (cfg: any) => listAccountIds(cfg),

      resolveAccount: (cfg: any, accountId?: string | null) => resolveAccount(cfg, accountId),

      defaultAccountId: (_cfg: any) => DEFAULT_ACCOUNT_ID,

      setAccountEnabled: ({ cfg, accountId, enabled }: any) => {
        const channelConfig = cfg?.channels?.[CHANNEL_ID] ?? {};
        if (accountId === DEFAULT_ACCOUNT_ID) {
          return {
            ...cfg,
            channels: {
              ...cfg.channels,
              [CHANNEL_ID]: { ...channelConfig, enabled },
            },
          };
        }
        return setAccountEnabledInConfigSection({
          cfg,
          sectionKey: `channels.${CHANNEL_ID}`,
          accountId,
          enabled,
        });
      },
    },

    pairing: {
      idLabel: "magicformUserId",
      normalizeAllowEntry: (entry: string) => entry.toLowerCase().trim(),
    },

    security: {
      resolveDmPolicy: ({
        cfg,
        accountId,
        account,
      }: {
        cfg: any;
        accountId?: string | null;
        account: ResolvedMagicFormAccount;
      }) => {
        const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
        const channelCfg = (cfg as any).channels?.[CHANNEL_ID];
        const useAccountPath = Boolean(channelCfg?.accounts?.[resolvedAccountId]);
        const basePath = useAccountPath
          ? `channels.${CHANNEL_ID}.accounts.${resolvedAccountId}.`
          : `channels.${CHANNEL_ID}.`;
        return {
          policy: account.dmPolicy ?? "open",
          allowFrom: account.allowFrom ?? [],
          policyPath: `${basePath}dmPolicy`,
          allowFromPath: basePath,
          approveHint: `openclaw pairing approve ${CHANNEL_ID} <code>`,
          normalizeEntry: (raw: string) => raw.toLowerCase().trim(),
        };
      },
      collectWarnings: ({ account }: { account: ResolvedMagicFormAccount }) => {
        const warnings: string[] = [];
        if (!account.apiToken) {
          warnings.push(
            "- MagicForm: api_token is not configured. The webhook will reject all requests.",
          );
        }
        if (!account.backendUrl) {
          warnings.push(
            "- MagicForm: backend_url is not configured. The bot cannot send callback responses.",
          );
        }
        if (account.dmPolicy === "open" && account.allowFrom.length === 0) {
          warnings.push(
            '- MagicForm: dmPolicy="open" with empty allow_from allows any stack to message the bot.',
          );
        }
        return warnings;
      },
    },

    messaging: {
      normalizeTarget: (target: string) => {
        const trimmed = target.trim();
        if (!trimmed) return undefined;
        return trimmed.replace(/^magicform:/i, "").trim();
      },
      targetResolver: {
        looksLikeId: (id: string) => {
          const trimmed = id?.trim();
          if (!trimmed) return false;
          // MagicForm targets are encoded as stack_id:conversation_id[:user_id]
          return /^magicform:/i.test(trimmed) || trimmed.includes(":");
        },
        hint: "<stack_id>:<conversation_id>[:<user_id>]",
      },
    },

    directory: {
      self: async () => null,
      listPeers: async () => [],
      listGroups: async () => [],
    },

    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 4000,

      sendText: async ({ to, text, accountId, cfg }: any) => {
        const account: ResolvedMagicFormAccount = resolveAccount(cfg ?? {}, accountId);

        if (!account.backendUrl) {
          throw new Error("MagicForm backend_url not configured");
        }

        // Parse the `to` field: stack_id:conversation_id[:user_id]
        const parts = splitTarget(to);
        if (!parts) {
          throw new Error(`Invalid MagicForm target format: ${to} (expected stack_id:conversation_id[:user_id])`);
        }
        const [stackId, conversationId, userId] = parts;

        const ok = await sendCallback(account.backendUrl, account.callbackPath, {
          stack_id: stackId,
          conversation_id: conversationId,
          ...(userId ? { user_id: userId } : {}),
          response: text,
          status: "success",
        }, account.apiToken);

        if (!ok) {
          throw new Error("Failed to send callback to MagicForm");
        }
        return { channel: CHANNEL_ID, messageId: `mf-${Date.now()}`, chatId: to };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { cfg, accountId, log } = ctx;
        const account = resolveAccount(cfg, accountId);

        if (!account.enabled) {
          log?.info?.(`MagicForm account ${accountId} is disabled, skipping`);
          return waitUntilAbort(ctx.abortSignal);
        }

        if (!account.apiToken || !account.backendUrl) {
          log?.warn?.(
            `MagicForm account ${accountId} not fully configured (missing api_token or backend_url)`,
          );
          return waitUntilAbort(ctx.abortSignal);
        }

        log?.info?.(
          `Starting MagicForm channel (account: ${accountId}, path: ${account.webhookPath})`,
        );

        const handler = createWebhookHandler({
          account,
          deliver: async (msg) => {
            const rt = getMagicFormRuntime();
            const currentCfg = await rt.config.loadConfig();

            // Build MsgContext using SDK's finalizeInboundContext
            const msgCtx = rt.channel.reply.finalizeInboundContext({
              Body: msg.body,
              RawBody: msg.body,
              CommandBody: msg.body,
              From: `magicform:${msg.from}`,
              To: `magicform:${msg.from}`,
              SessionKey: msg.sessionKey,
              AccountId: account.accountId,
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: `magicform:${msg.from}`,
              ChatType: msg.chatType,
              SenderName: msg.senderName,
              SenderId: msg.from,
              Provider: CHANNEL_ID,
              Surface: CHANNEL_ID,
              ConversationLabel: msg.senderName || msg.from,
              Timestamp: Date.now(),
              CommandAuthorized: true,
            });

            // Dispatch via the SDK's buffered block dispatcher.
            // Pass per-request overrides from the webhook payload through replyOptions
            // so they reach getReplyFromConfig → workspace/config-dir/tool resolution.
            await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              replyOptions: {
                workspaceOverride: msg.workspaceOverride,
                configDirOverride: msg.configDirOverride,
                toolsProfileOverride: msg.toolsProfileOverride,
                toolsAllowOverride: msg.toolsAllowOverride,
                toolsDenyOverride: msg.toolsDenyOverride,
              },
              dispatcherOptions: {
                deliver: async (payload: { text?: string; body?: string }) => {
                  const text = payload?.text ?? payload?.body;
                  if (text) {
                    // Parse from field for callback routing
                    const parts = splitTarget(msg.from);
                    if (parts) {
                      const [stackId, conversationId, userId] = parts;
                      await sendCallback(
                        account.backendUrl,
                        account.callbackPath,
                        {
                          stack_id: stackId,
                          conversation_id: conversationId,
                          ...(userId ? { user_id: userId } : {}),
                          response: text,
                          status: "success",
                        },
                        account.apiToken,
                      );
                    }
                  }
                },
                onReplyStart: () => {
                  log?.info?.(`Agent reply started for ${msg.from}`);
                },
              },
            });

            return null;
          },
          log,
        });

        // Deregister any stale route from a previous start
        const routeKey = `${accountId}:${account.webhookPath}`;
        const prevUnregister = activeRouteUnregisters.get(routeKey);
        if (prevUnregister) {
          log?.info?.(`Deregistering stale route before re-registering: ${account.webhookPath}`);
          prevUnregister();
          activeRouteUnregisters.delete(routeKey);
        }

        const unregister = registerPluginHttpRoute({
          path: account.webhookPath,
          auth: "plugin",
          replaceExisting: true,
          pluginId: CHANNEL_ID,
          accountId: account.accountId,
          log: (msg: string) => log?.info?.(msg),
          handler,
        });
        activeRouteUnregisters.set(routeKey, unregister);

        log?.info?.(`Registered HTTP route: ${account.webhookPath} for MagicForm`);

        return waitUntilAbort(ctx.abortSignal, () => {
          log?.info?.(`Stopping MagicForm channel (account: ${accountId})`);
          if (typeof unregister === "function") unregister();
          activeRouteUnregisters.delete(routeKey);
        });
      },

      stopAccount: async (ctx: any) => {
        ctx.log?.info?.(`MagicForm account ${ctx.accountId} stopped`);
        // Clean up any registered routes for this account
        for (const [routeKey, unregister] of activeRouteUnregisters) {
          if (routeKey.startsWith(`${ctx.accountId}:`)) {
            unregister();
            activeRouteUnregisters.delete(routeKey);
          }
        }
      },
    },

    agentPrompt: {
      messageToolHints: () => [
        "",
        "### MagicForm Formatting",
        "MagicForm supports markdown formatting in responses.",
        "",
        "**Best practices**:",
        "- Use clear, structured responses",
        "- Use markdown headers, lists, and code blocks as needed",
        "- Keep responses focused and actionable",
        "- Responses over 4000 characters will be chunked",
      ],
    },
  };
}
