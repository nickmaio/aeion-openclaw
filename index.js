import { fetch } from "undici";
import { io } from "socket.io-client";

export default class aeionChannel {
  constructor(config, context) {
    this.config = config;
    this.context = context;
    this.socket = null;
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

  async stop() {
    if (this.socket) {
      this.socket.close();
      this.context.logger.info("[aeion] Bridge stopped.");
    }
  }
}
