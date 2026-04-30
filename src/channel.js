import {
  createChannelPluginBase,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";

export const CHANNEL_ID = "aeion";

function readAeionChannelConfig(cfg) {
  return cfg?.channels?.[CHANNEL_ID] || {};
}

function resolveAccount(cfg, accountId = null) {
  const section = readAeionChannelConfig(cfg);
  const apiKey = section.apiKey || section.token;

  if (!apiKey) {
    throw new Error("aeion: channels.aeion.apiKey is required");
  }

  return {
    accountId,
    apiKey,
    token: apiKey,
    allowFrom: section.allowFrom || [],
    dmPolicy: section.dmSecurity,
  };
}

export const aeionPlugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "aeion",
      selectionLabel: "aeion",
      detailLabel: "aeion platform bridge",
      docsPath: "https://aeion.org/",
      docsLabel: "aeion",
      blurb: "Connect OpenClaw to aeion web and mobile rooms.",
      markdownCapable: true,
      exposure: {
        configured: true,
        setup: true,
        docs: true,
      },
    },
    setup: {
      resolveAccount,
      inspectAccount(cfg) {
        const section = readAeionChannelConfig(cfg);
        const configured = Boolean(section.apiKey || section.token);

        return {
          enabled: configured,
          configured,
          tokenStatus: configured ? "available" : "missing",
        };
      },
    },
  }),

  security: {
    dm: {
      channelKey: CHANNEL_ID,
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },

  threading: { topLevelReplyToMode: "reply" },
});
