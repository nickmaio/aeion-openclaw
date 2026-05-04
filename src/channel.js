import { fetch } from "undici";
import { io } from "socket.io-client";

const CHANNEL_ID = "aeion";

class AeionChannelRuntime {
  constructor(account, runtime, log) {
    this.account = account;
    this.runtime = runtime;
    this.log = log;
    this.socket = null;
    this.typingTimers = new Map();
  }

  async start(abortSignal) {
    try {
      const { apiKey } = this.account;
      const serverUrl = "https://api.aeion.org/";

      this.log?.info(`[aeion] Starting connection with API key: ${apiKey ? apiKey.substring(0, 3) + "..." : "MISSING"}`);

      if (!apiKey) {
        throw new Error("aeion: apiKey is required");
      }

      this.socket = io(serverUrl, {
        auth: { token: 'Bearer ' + apiKey, agent: 'OpenClaw', platform: 'aeion' },
        reconnection: true,
        withCredentials: true,
        reconnectionAttempts: 10
      });

      // Wait for socket to connect
      await new Promise((resolve, reject) => {
        const connectTimeout = setTimeout(() => {
          reject(new Error("Socket connection timeout after 10 seconds"));
        }, 10000);

        this.socket.on("connect", () => {
          clearTimeout(connectTimeout);
          this.log?.info("✓ [aeion] Connected to aeion API server");
          resolve();
        });

        this.socket.on("connect_error", (err) => {
          clearTimeout(connectTimeout);
          this.log?.error(`✗ [aeion] Connection Error: ${err.message}`);
          reject(err);
        });

        this.socket.on("error", (err) => {
          clearTimeout(connectTimeout);
          this.log?.error(`✗ [aeion] Socket Error: ${err}`);
          reject(err);
        });
      });

      // Set up message handler
      this.socket.on("msg", async (payload) => {
        await this.handleInboundMessage(payload);
      });

      this.socket.on("disconnect", () => {
        this.log?.warn("[aeion] Disconnected from aeion API server");
      });

      this.log?.info("[aeion] ✓ Socket fully initialized and listening for messages");

      // Wait for abort signal
      await new Promise < void> ((resolve) => {
        abortSignal.addEventListener("abort", () => {
          this.log?.info("[aeion] Abort signal received, stopping...");
          resolve();
        }, { once: true });
      });

    } catch (err) {
      this.log?.error(`✗ [aeion] FATAL ERROR: ${err.message}`);
      throw err;
    } finally {
      await this.stop();
    }
  }

  async handleInboundMessage(payload) {
    try {
      const { to, td, by, m, b, _id } = payload;
      this.log?.info(`[aeion] ✓ MESSAGE RECEIVED from ${by?.n} to bot ${to} in room ${td}`);
      this.log?.info(`[aeion] Message text: "${m}"`);

      let mediaPaths = [];
      const serverUrl = "https://api.aeion.org/";

      // Download attachments
      if (b && b.length > 0) {
        for (let i = 0; i < b.length; i++) {
          const fileInfo = b[i];
          const fileUrl = `${serverUrl}/api/msgo/att/${_id}/${i}/${fileInfo.n}`;

          try {
            this.log?.info(`[aeion] Downloading attachment: ${fileInfo.n}`);
            const response = await fetch(fileUrl, {
              headers: { 'Authorization': `Bearer ${this.account.apiKey}` }
            });

            if (!response.ok) {
              throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            const savedFile = await this.runtime.channel.media.saveMediaBuffer(buffer, fileInfo.t, "inbound");
            mediaPaths.push(savedFile);
            this.log?.info(`[aeion] ✓ Attachment saved: ${savedFile}`);
          } catch (err) {
            this.log?.error(`[aeion] Failed to download ${fileInfo.n}: ${err.message}`);
          }
        }
      }

      // Build context for agent
      const contextPayload = {
        Body: m,
        BodyForAgent: m,
        From: `aeion:${by?.n || by?.id || "unknown"}`,
        To: `aeion:${to}`,
        SessionKey: `${to}:${td}`,
        ChatType: "direct",
        ConversationLabel: `aeion room ${td}`,
        SenderName: by?.n || "aeionUser",
        SenderId: by?.id || "unknown",
        Provider: "aeion",
        Surface: "aeion",
        MessageSid: _id,
        Timestamp: Date.now(),
        OriginatingChannel: "aeion",
        OriginatingTo: `aeion:${to}`,
        CommandAuthorized: true,
        metadata: {
          botId: to,
          roomId: td,
          msgId: _id
        }
      };

      if (mediaPaths.length > 0) {
        contextPayload.MediaPaths = mediaPaths;
        contextPayload.NumMedia = mediaPaths.length;
      }

      const finalContext = this.runtime.channel.reply.finalizeInboundContext(contextPayload);

      this.log?.info(`[aeion] Dispatching message to agent...`);

      // Create dispatcher for replies
      const { dispatcher, replyOptions, markDispatchIdle } = this.runtime.channel.reply.createReplyDispatcherWithTyping({
        deliver: async (payload) => {
          await this.sendMessage(payload, to, td);
        },
        onReplyStart: () => this.startTyping(to, td),
        onError: (err, info) => {
          this.log?.error(`[aeion] Dispatch error (${info.kind}): ${err.message}`);
        },
      });

      try {
        await this.runtime.channel.reply.dispatchReplyFromConfig({
          ctx: finalContext,
          cfg: this.runtime.cfg,
          dispatcher,
          replyOptions,
        });
      } finally {
        markDispatchIdle();
        this.stopTyping(to, td);
      }

      this.log?.info(`[aeion] ✓ Message handled successfully`);
    } catch (err) {
      this.log?.error(`[aeion] ✗ Error handling inbound message: ${err.message}`);
    }
  }

  async sendMessage(payload, botId, roomId) {
    try {
      const text = (payload.text || "").trim();
      if (!text && !payload.media) {
        this.log?.info("[aeion] Skipping empty message");
        return;
      }

      this.log?.info(`[aeion] Sending message to room ${botId}-${roomId}: "${text.substring(0, 50)}..."`);

      const msgPayload = {
        m: text || " ",
        to: botId,
        td: roomId,
        atts: []
      };

      this.socket.emit("msg_send", msgPayload);
      this.log?.info(`[aeion] ✓ Message sent`);
    } catch (err) {
      this.log?.error(`[aeion] ✗ Error sending message: ${err.message}`);
      throw err;
    }
  }

  startTyping(botId, roomId) {
    if (!this.socket) return;
    const payload = { to: botId };
    if (roomId) payload.td = roomId;
    this.socket.emit("typing", payload);
  }

  stopTyping(botId, roomId) {
    if (!this.socket) return;
    const payload = { to: botId };
    if (roomId) payload.td = roomId;
    this.socket.emit("typing_stop", payload);
  }

  async stop() {
    this.log?.info("[aeion] Stopping...");
    if (this.socket) {
      this.socket.close();
      this.log?.info("[aeion] ✓ Socket closed");
    }
  }
}

export const aeionPlugin = {
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
  },
  capabilities: {
    chatTypes: ["direct"],
    supports: { mentions: false },
  },
  config: {
    listAccountIds: (cfg) => {
      const aeionCfg = cfg.channels?.aeion;
      return aeionCfg?.apiKey || aeionCfg?.token ? ["default"] : [];
    },
    resolveAccount: (cfg, id) => {
      const aeionCfg = cfg.channels?.aeion || {};
      return {
        apiKey: aeionCfg.apiKey || aeionCfg.token,
        allowFrom: aeionCfg.allowFrom || [],
        dmPolicy: aeionCfg.dmSecurity || "allowlist",
      };
    },
    isConfigured: (account) => !!account.apiKey,
    describeAccount: (account) => ({
      accountId: "default",
      name: "aeion",
      enabled: true,
      configured: !!account.apiKey,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;

      if (!account.apiKey) {
        ctx.log?.warn("[aeion] Not configured, skipping start");
        return;
      }

      ctx.log?.info("[aeion] Starting gateway account...");
      ctx.setStatus({ accountId: account.accountId || "default", running: true });

      try {
        const runtime = new AeionChannelRuntime(account, ctx.runtime, ctx.log);
        await runtime.start(ctx.abortSignal);
      } catch (err) {
        ctx.log?.error(`[aeion] Gateway error: ${err.message}`);
        ctx.setStatus({ accountId: account.accountId || "default", running: false, lastError: err.message });
        throw err;
      } finally {
        ctx.setStatus({ accountId: account.accountId || "default", running: false });
      }
    },
  },
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
  },
};
