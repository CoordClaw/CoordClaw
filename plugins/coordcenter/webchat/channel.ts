import { type ChannelPlugin } from "openclaw/plugin-sdk/core";

export interface WebchatAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  port?: number;
}

export const webchatPlugin: ChannelPlugin<WebchatAccount> = {
  id: "webchat",
  meta: {
    id: "webchat",
    label: "Web Chat",
    selectionLabel: "Web Chat (localhost)",
    blurb: "Local web-based chat UI served at http://localhost:3210",
    order: 100,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    reactions: false,
    threads: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.webchat"] },

  config: {
    listAccountIds: (_cfg) => ["local"],
    resolveAccount: (_cfg, accountId) => {
      const effectiveId = accountId?.trim() || "local";
      return {
        accountId: effectiveId,
        name: "Local Web Chat",
        enabled: true,
        port: 3210,
      };
    },
    defaultAccountId: () => "local",
    isConfigured: () => true,
    describeAccount: (account) => ({
      accountId: account?.accountId ?? "local",
      name: account?.name ?? "Local Web Chat",
      enabled: account?.enabled ?? true,
      configured: true,
    }),
  },

  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ channel: "webchat" as const, messageId: "" }),
    sendMedia: async () => ({ channel: "webchat" as const, messageId: "" }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal, log, cfg } = ctx;
      const port = (account as any).port ?? 3210;

      log?.info(`[webchat] Starting gateway — accountId=${account.accountId} port=${port}`);

      const { startGateway } = await import("./gateway");
      await startGateway({
        account: { ...account, port },
        abortSignal,
        cfg,
        log,
        onReady: () => {
          log?.info(`[webchat] Gateway ready on http://localhost:${port}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
        },
        onError: (error) => {
          log?.error(`[webchat] Gateway error: ${error.message}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: error.message,
          });
        },
      });
    },
  },

  status: {
    defaultRuntime: {
      accountId: "local",
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
  },
};