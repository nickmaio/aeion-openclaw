import { fetch } from "undici";
import { io } from "socket.io-client";

const CHANNEL_ID = "aeion";

class AeionChannel {
  constructor(account, api) {
    this.account = account;
    this.api = api;
    this.socket = null;
    this.typingTimers = new Map();
  }

  async start() {
    const { apiKey } = this.account;
    const serverUrl = "https://api.aeion.org/";

    if (!apiKey) {
      throw new Error("aeion: apiKey is required");
    }

    this.api.logger.info(`[aeion] initializing bridge for user key: ${apiKey.substring(0, 3)}...`);

    this.socket = io(serverUrl, {
      auth: { token: 'Bearer ' + apiKey, agent: 'OpenClaw', platform: 'aeion' },
      reconnection: true,
      withCredentials: true,
      reconnectionAttempts: 10
    });

    this.socket.on("msg", async (payload) => {
      const { to, td, by, m, b, _id } = payload;
      let mediaPaths = [];
      const typingKey = this.getTypingKey(to, td);

      this.api.logger.info(`[aeion] new message`);

      if (b && b.length > 0) {
        for (let i = 0; i < b.length; i++) {
          const fileInfo = b[i];
          const fileUrl = `${serverUrl}/api/msgo/att/${_id}/${i}/${fileInfo.n}`;

          try {
            this.api.logger.info(`[aeion] Downloading attachment: ${fileInfo.n}`);

            const response = await fetch(fileUrl, {
              headers: { 'Authorization': `Bearer ${apiKey}` }
            });

            if (!response.ok) {
              throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            const savedFile = await this.api.saveMediaBuffer(buffer, fileInfo.n, fileInfo.t);
            mediaPaths.push(savedFile.path);
          } catch (err) {
            this.api.logger.error(`[aeion] Failed to download ${fileInfo.n}: ${err.message}`);
          }
        }
      }

      this.startTyping(to, td);
      try {
        await this.api.receive({
          text: m,
          sender: by?.n || "aeionUser",
          channel: CHANNEL_ID,
          mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
          metadata: {
            botId: to,
            roomId: td,
            msgId: _id
          }
        });
      } finally {
        this.stopTyping(to, td, typingKey);
      }
    });

    this.socket.on("connect", () => {
      this.api.logger.info("Connected to aeion API");
    });

    this.socket.on("connect_error", (err) => {
      this.api.logger.error(`[aeion] Connection Error: ${err.message}`);
    });
  }

  getTypingKey(botId, roomId) {
    return `${botId || ""}:${roomId || ""}`;
  }

  emitTypingEvent(eventName, botId, roomId) {
    if (!this.socket) return;
    const payload = { to: botId };
    if (roomId) payload.td = roomId;
    this.socket.emit(eventName, payload);
  }

  startTyping(botId, roomId) {
    const key = this.getTypingKey(botId, roomId);
    this.stopTyping(botId, roomId, key);
    this.emitTypingEvent("typing", botId, roomId);
    const timer = setInterval(() => {
      this.emitTypingEvent("typing", botId, roomId);
    }, 4000);
    this.typingTimers.set(key, timer);
  }

  stopTyping(botId, roomId, key = this.getTypingKey(botId, roomId)) {
    const timer = this.typingTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(key);
    }
    this.emitTypingEvent("typing_stop", botId, roomId);
  }

  async stop() {
    if (this.socket) {
      for (const timer of this.typingTimers.values()) {
        clearInterval(timer);
      }
      this.typingTimers.clear();
      this.socket.close();
      this.api.logger.info("[aeion] Bridge stopped.");
    }
  }
}

export default function register(api) {
  api.registerChannel({
    plugin: {
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
      },
      outbound: {
        create: (account, api) => new AeionChannel(account, api),
        deliveryMode: "direct",
        sendText: async ({ text, target, account, api }) => {
          // This would be called when sending messages
          return { ok: true };
        },
      },
    },
  });
}
