import { fetch } from "undici";
import { io } from "socket.io-client";

export default class aeionChannel {
  constructor(config, context) {
    this.config = config;
    this.context = context;
    this.socket = null;
    this.typingTimers = new Map();
  }

  async start() {
    const { apiKey } = this.config;
    const serverUrl = "https://api.aeion.org/";

    this.context.logger.info(`[aeion] initializing bridge for user key: ${apiKey.substring(0, 3)}...`);

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

      this.context.logger.info(`[aeion] new message`);

      if (b && b.length > 0) {
        for (let i = 0; i < b.length; i++) {
          const fileInfo = b[i];

          const fileUrl = `${serverUrl}/api/msgo/att/${_id}/${i}/${fileInfo.n}`;

          try {
            this.context.logger.info(`[aeion] Downloading attachment: ${fileInfo.n}`);

            const response = await fetch(fileUrl, {
              headers: { 'Authorization': `Bearer ${apiKey}` }
            });

            if (!response.ok) {
              throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());

            const savedFile = await this.context.saveMediaBuffer(
              buffer,
              fileInfo.n,
              fileInfo.t
            );
            mediaPaths.push(savedFile.path);
          } catch (err) {
            this.context.logger.error(`[aeion] Failed to download ${fileInfo.n}: ${err.message}`);
          }
        }
      }

      this.startTyping(to, td);
      try {
        await this.context.receive({
          text: m,
          sender: by?.n || "aeionUser",
          channel: "aeion",
          MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
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
      this.context.logger.info("Connected to aeion API");
    });

    this.socket.on("connect_error", (err) => {
      this.context.logger.error(`[aeion] Connection Error: ${err.message}`);
    });
  }

  async send(envelope) {
    const { text, metadata, attachments } = envelope;
    const { botId, roomId } = metadata || {};

    if (roomId && botId) {
      this.context.logger.info(`[aeion] sending response to room: ${botId}-${roomId}`);

      const payload = {
        m: text,
        to: botId,
        td: roomId,
        atts: []
      };

      if (attachments?.length > 0) {
        payload.atts = await Promise.all(attachments.map(async (attr) => {
          const buffer = await this.context.readMediaFile(attr.path);
          return {
            name: attr.name,
            type: attr.mimeType,
            size: attr.size,
            data: buffer.toString('base64')
          };
        }));
      }

      this.socket.emit("msg_send", payload);

    } else {
      this.context.logger.warn("[aeion] received response but no Room ID was found in metadata.");
    }
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
      this.context.logger.info("[aeion] Bridge stopped.");
    }
  }
}
