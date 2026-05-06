import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { fetch } from "undici";
import { io } from "socket.io-client";
import { getAeionRuntime } from "./runtime.js";

const CHANNEL_ID = "aeion";
const AEION_SERVER_URL = "https://api.aeion.org";
const activeRuntimes = new Map();

function asString(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function firstString(...values) {
  for (const value of values) {
    const text = asString(value).trim();
    if (text) return text;
  }
  return "";
}

function normalizeAllowValue(value) {
  return asString(value).trim().replace(/^aeion:/i, "").toLowerCase();
}

function isObjectIdHex(value) {
  return /^[a-f0-9]{24}$/i.test(asString(value).trim());
}

function base64urlToHex(value) {
  const normalized = asString(value).trim();
  if (!normalized || isObjectIdHex(normalized)) return normalized;

  try {
    const base64 = normalized.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const hex = Buffer.from(padded, "base64").toString("hex");
    return isObjectIdHex(hex) ? hex : normalized;
  } catch {
    return normalized;
  }
}

function hexToBase64url(value) {
  const normalized = asString(value).trim();
  if (!isObjectIdHex(normalized)) return normalized;
  return Buffer.from(normalized, "hex").toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function toMongoId(value) {
  return base64urlToHex(value);
}

function toSocketRoomId(value) {
  return hexToBase64url(value);
}

function normalizeAeionSender(by) {
  if (!by) {
    return { id: "unknown", name: "aeionUser", raw: by };
  }
  if (typeof by === "string") {
    return { id: by, name: by, raw: by };
  }

  const id = firstString(by.id, by._id, by.u, by.user, by.o, by.uid);
  const name = firstString(by.n, by.name, by.username, by.label, id, "aeionUser");
  const avatar = firstString(by.a, by.avtr, by.avatar, by.photo?.i);
  return {
    id: id || name || "unknown",
    name,
    avatar,
    raw: by,
  };
}

function normalizeAeionRoute(payload) {
  const botId = asString(payload?.to);
  const roomId = asString(payload?.td);
  return {
    botId,
    roomId,
    targetId: roomId || botId,
    sessionKey: roomId ? `${botId}:${roomId}` : botId,
    label: roomId ? `aeion room ${roomId}` : `aeion ${botId}`,
  };
}

function parseAeionTarget(to) {
  const raw = asString(to).trim().replace(/^aeion:/i, "");
  if (!raw) {
    return { ok: false, error: new Error("Missing Aeion target. Use aeion:<botId>:<roomId>") };
  }

  let botId = "";
  let roomId = "";
  if (raw.includes("/")) {
    [botId, roomId = ""] = raw.split("/", 2);
  } else if (raw.includes("|")) {
    [botId, roomId = ""] = raw.split("|", 2);
  } else {
    [botId, roomId = ""] = raw.split(":", 2);
  }

  botId = asString(botId).trim();
  roomId = asString(roomId).trim();
  if (!botId) {
    return { ok: false, error: new Error(`Invalid Aeion target: ${to}`) };
  }

  return {
    ok: true,
    botId,
    roomId,
    encoded: roomId ? `${botId}:${roomId}` : botId,
  };
}

function getActiveRuntime(accountId) {
  return activeRuntimes.get(accountId || "default") || activeRuntimes.get("default");
}

function getAllowCandidates(payload) {
  const sender = normalizeAeionSender(payload?.by);
  const route = normalizeAeionRoute(payload);
  return [
    sender.id,
    sender.name,
    route.roomId,
    route.botId,
    route.sessionKey,
  ].map(normalizeAllowValue).filter(Boolean);
}

function inferMimeType(filePath, fallback = "application/octet-stream") {
  const ext = basename(filePath).toLowerCase().split(".").pop();
  const mimeTypes = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    mp4: "video/mp4",
    mov: "video/quicktime",
  };
  return mimeTypes[ext] || fallback;
}

function coerceOutboundMedia(payload) {
  const values = [
    payload?.media,
    payload?.mediaFiles,
    payload?.attachments,
    payload?.files,
  ];
  const items = [];
  for (const value of values) {
    const entries = Array.isArray(value) ? value : (value ? [value] : []);
    for (const entry of entries) {
      if (typeof entry === "string") {
        items.push({ path: entry });
        continue;
      }
      if (entry && typeof entry === "object") {
        const path = entry.path || entry.filePath || entry.file_path || entry.url;
        if (!path) continue;
        items.push({
          path,
          filename: entry.filename || entry.name,
          mimeType: entry.mimeType || entry.mime_type || entry.type,
        });
      }
    }
  }
  return items;
}

class AeionChannelRuntime {
  constructor(account, cfg, log, statusSink) {
    this.account = account;
    this.cfg = cfg;
    this.log = log;
    this.statusSink = statusSink;
    this.socket = null;
  }

  async start(abortSignal) {
    try {
      const { apiKey } = this.account;
      this.log?.info(`[aeion] Starting connection with API key: ${apiKey ? apiKey.substring(0, 3) + "..." : "MISSING"}`);

      if (!apiKey) {
        throw new Error("aeion: apiKey is required");
      }

      this.socket = io(AEION_SERVER_URL, {
        transports: ["websocket"],
        auth: { token: "bearer " + apiKey, agent: "OpenClaw", platform: "aeion" },
        withCredentials: true,
        reconnection: true,
        reconnectionAttempts: 10,
      });

      await new Promise((resolve, reject) => {
        const connectTimeout = setTimeout(() => {
          reject(new Error("Socket connection timeout after 10 seconds"));
        }, 10000);

        this.socket.on("connect", () => {
          clearTimeout(connectTimeout);
          this.statusSink?.({ running: true, connected: true, lastError: null });
          this.log?.info("[aeion] Connected to aeion API server");
          resolve();
        });

        this.socket.on("connect_error", (err) => {
          clearTimeout(connectTimeout);
          this.statusSink?.({ connected: false, lastError: err.message });
          this.log?.error(`[aeion] Connection Error: ${err.message}`);
          reject(err);
        });

        this.socket.on("error", (err) => {
          const message = err?.message || String(err);
          clearTimeout(connectTimeout);
          this.statusSink?.({ lastError: message });
          this.log?.error(`[aeion] Socket Error: ${message}`);
          reject(err);
        });
      });

      this.socket.on("msg", async (payload) => {
        await this.handleInboundMessage(payload);
      });

      this.socket.on("disconnect", () => {
        this.statusSink?.({ connected: false });
        this.log?.warn("[aeion] Disconnected from aeion API server");
      });

      this.log?.info("[aeion] Socket fully initialized and listening for messages");

      await new Promise((resolve) => {
        abortSignal.addEventListener("abort", () => {
          this.log?.info("[aeion] Abort signal received, stopping...");
          resolve();
        }, { once: true });
      });
    } catch (err) {
      this.log?.error(`[aeion] FATAL ERROR: ${err.message}`);
      throw err;
    } finally {
      await this.stop();
    }
  }

  async handleInboundMessage(payload) {
    try {
      const sender = normalizeAeionSender(payload?.by);
      const route = normalizeAeionRoute(payload);
      if (!this.isInboundAllowed(payload)) {
        this.log?.warn(`[aeion] Inbound message blocked by dmSecurity policy from ${sender.id} in room ${route.targetId || "unknown"}`);
        return;
      }

      this.log?.info(`[aeion] Message received from ${sender.name} to bot ${route.botId} in room ${route.roomId || "main"}`);
      this.log?.info(`[aeion] Message text: "${payload?.m || ""}"`);

      const core = getAeionRuntime();
      const inboundMedia = await this.resolveInboundMedia(core, payload);
      const contextPayload = {
        Body: payload?.m || "",
        BodyForAgent: payload?.m || "",
        From: `aeion:${sender.id}`,
        To: `aeion:${route.botId}`,
        SessionKey: route.sessionKey,
        ChatType: "direct",
        ConversationLabel: route.label,
        SenderName: sender.name,
        SenderId: sender.id,
        Provider: "aeion",
        Surface: "aeion",
        MessageSid: payload?._id,
        Timestamp: Date.now(),
        OriginatingChannel: "aeion",
        OriginatingTo: `aeion:${route.botId}`,
        CommandAuthorized: true,
        metadata: {
          botId: route.botId,
          roomId: route.roomId,
          targetId: route.targetId,
          msgId: payload?._id,
          sender: sender.raw,
        },
      };

      if (sender.avatar) {
        contextPayload.SenderAvatar = sender.avatar;
      }
      this.addMediaContext(contextPayload, inboundMedia);

      const finalContext = core.channel.reply.finalizeInboundContext(contextPayload);
      this.log?.info("[aeion] Dispatching message to agent...");

      let dispatchFailed = false;
      const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
        deliver: async (replyPayload) => {
          await this.sendMessage(replyPayload, route.botId, route.roomId);
        },
        onReplyStart: () => this.startTyping(route.botId, route.roomId),
        onError: (err, info) => {
          dispatchFailed = true;
          this.log?.error(`[aeion] Dispatch error (${info.kind}): ${err.message}`);
        },
      });

      try {
        await core.channel.reply.dispatchReplyFromConfig({
          ctx: finalContext,
          cfg: this.cfg,
          dispatcher,
          replyOptions,
        });
      } finally {
        markDispatchIdle();
        this.stopTyping(route.botId, route.roomId);
      }

      if (dispatchFailed) {
        this.log?.warn("[aeion] Message processing finished with dispatch errors");
      } else {
        this.log?.info("[aeion] Message handled successfully");
      }
    } catch (err) {
      this.log?.error(`[aeion] Error handling inbound message: ${err.message}`);
    }
  }

  isInboundAllowed(payload) {
    const policy = this.account.dmPolicy || "allowlist";
    if (policy === "disabled") return false;
    if (policy === "open") return true;

    const allowFrom = Array.isArray(this.account.allowFrom) ? this.account.allowFrom : [];
    const allowed = new Set(allowFrom.map(normalizeAllowValue).filter(Boolean));
    if (allowed.size === 0) return false;

    return getAllowCandidates(payload).some((candidate) => allowed.has(candidate));
  }

  async resolveInboundMedia(core, payload) {
    const attachments = Array.isArray(payload?.b) ? payload.b : [];
    if (!attachments.length) return [];

    const media = [];
    for (let i = 0; i < attachments.length; i++) {
      const fileInfo = attachments[i] || {};
      const filename = asString(fileInfo.n || fileInfo.name || `attachment-${i}`);
      const mimeType = asString(fileInfo.t || fileInfo.type || "application/octet-stream");
      const fileUrl = `${AEION_SERVER_URL}/api/msgo/att/${payload?._id}/${i}/${encodeURIComponent(filename)}`;

      try {
        this.log?.info(`[aeion] Downloading attachment: ${filename}`);
        const response = await fetch(fileUrl, {
          headers: { Authorization: `Bearer ${this.account.apiKey}` },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const saved = await this.persistInboundMedia(core, {
          buffer,
          filename,
          mimeType,
        });
        media.push({
          id: `${payload?._id || "message"}-${i}`,
          path: saved,
          filename,
          mimeType,
          size: Number(fileInfo.s || fileInfo.size || buffer.byteLength),
        });
        this.log?.info(`[aeion] Attachment saved: ${saved}`);
      } catch (err) {
        this.log?.error(`[aeion] Failed to download ${filename}: ${err.message}`);
      }
    }

    return media;
  }

  async persistInboundMedia(core, file) {
    const saveMediaBuffer = core?.channel?.media?.saveMediaBuffer;
    if (typeof saveMediaBuffer !== "function") {
      throw new Error("OpenClaw media runtime is unavailable");
    }

    const saved = await saveMediaBuffer(
      file.buffer,
      file.mimeType,
      "inbound",
      undefined,
      file.filename,
    );
    if (typeof saved === "string") return saved;
    if (saved && typeof saved === "object") {
      const savedPath = saved.path || saved.url || saved.filePath;
      if (savedPath) return savedPath;
    }
    throw new Error("OpenClaw media runtime returned no path");
  }

  addMediaContext(contextPayload, inboundMedia) {
    if (!inboundMedia.length) return;

    const mediaPaths = inboundMedia.map((item) => item.path);
    const mediaTypes = inboundMedia.map((item) => item.mimeType || "application/octet-stream");
    const first = inboundMedia[0];
    contextPayload.Media = inboundMedia;
    contextPayload.MediaPath = first.path;
    contextPayload.MediaType = first.mimeType;
    contextPayload.MediaUrl = first.path;
    contextPayload.MediaPaths = mediaPaths;
    contextPayload.MediaUrls = mediaPaths;
    contextPayload.MediaTypes = mediaTypes;
    contextPayload.NumMedia = inboundMedia.length;
    inboundMedia.forEach((item, index) => {
      contextPayload[`MediaUrl${index}`] = item.path;
    });
  }

  async sendMessage(payload, botId, roomId) {
    try {
      const text = (payload.text || "").trim();
      const mediaSpecs = coerceOutboundMedia(payload);
      const attachments = await this.buildOutboundAttachments(mediaSpecs);
      if (!text && attachments.length === 0) {
        this.log?.info("[aeion] Skipping empty message");
        return;
      }

      this.log?.info(`[aeion] Sending message to room ${botId}-${roomId || "main"}: "${text.substring(0, 50)}..."`);
      const socket = this.getConnectedSocket();
      if (!socket) {
        throw new Error("aeion gateway is not connected");
      }

      const msgPayload = {
        m: text || " ",
        to: toMongoId(botId),
        td: roomId ? toMongoId(roomId) : undefined,
        atts: attachments,
      };
      if (msgPayload.td && msgPayload.td !== roomId) {
        this.log?.info(`[aeion] Converted room id for msg_send: ${roomId} -> ${msgPayload.td}`);
      }

      socket.emit("msg_send", msgPayload);
      this.log?.info("[aeion] Message sent");
      return {
        channel: CHANNEL_ID,
        ok: true,
        messageId: `${botId}:${roomId || "main"}:${Date.now()}`,
      };
    } catch (err) {
      this.log?.error(`[aeion] Error sending message: ${err.message}`);
      throw err;
    }
  }

  getConnectedSocket() {
    if (this.socket?.connected) return this.socket;

    const activeRuntime = getActiveRuntime(this.account.accountId);
    if (activeRuntime?.socket?.connected) {
      this.log?.info("[aeion] Using current active socket for delayed delivery");
      return activeRuntime.socket;
    }

    return null;
  }

  async buildOutboundAttachments(mediaSpecs) {
    const attachments = [];
    for (const media of mediaSpecs) {
      try {
        if (!media.path || /^https?:\/\//i.test(media.path)) {
          this.log?.warn(`[aeion] Skipping unsupported outbound media path: ${media.path || "missing"}`);
          continue;
        }
        const buffer = await readFile(media.path);
        const info = await stat(media.path);
        const filename = media.filename || basename(media.path);
        const mimeType = media.mimeType || inferMimeType(media.path);
        attachments.push({
          name: filename,
          originalFilename: filename,
          type: mimeType,
          mimetype: mimeType,
          size: info.size || buffer.byteLength,
          data: buffer.toString("base64"),
        });
      } catch (err) {
        this.log?.error(`[aeion] Failed to attach outbound media ${media.path}: ${err.message}`);
      }
    }
    return attachments;
  }

  startTyping(botId, roomId) {
    const socket = this.getConnectedSocket();
    if (!socket) return;
    const payload = { to: botId };
    if (roomId) payload.td = toSocketRoomId(roomId);
    socket.emit("typing", payload);
  }

  stopTyping(botId, roomId) {
    const socket = this.getConnectedSocket();
    if (!socket) return;
    const payload = { to: botId };
    if (roomId) payload.td = toSocketRoomId(roomId);
    socket.emit("typing_stop", payload);
  }

  async stop() {
    this.log?.info("[aeion] Stopping...");
    if (this.socket) {
      this.socket.close();
      this.socket = null;
      this.log?.info("[aeion] Socket closed");
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
    media: true,
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
        accountId: id || "default",
        apiKey: aeionCfg.apiKey || aeionCfg.token,
        allowFrom: aeionCfg.allowFrom || [],
        dmPolicy: aeionCfg.dmSecurity || "allowlist",
      };
    },
    isConfigured: (account) => !!account.apiKey,
    describeAccount: (account) => ({
      accountId: account.accountId || "default",
      name: "aeion",
      enabled: true,
      configured: !!account.apiKey,
      dmPolicy: account.dmPolicy,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const target = parseAeionTarget(to);
      if (!target.ok) return { ok: false, error: target.error };
      return { ok: true, to: target.encoded };
    },
    sendText: async ({ to, text, accountId }) => {
      const target = parseAeionTarget(to);
      if (!target.ok) {
        return { channel: CHANNEL_ID, ok: false, error: target.error.message };
      }

      const runtime = getActiveRuntime(accountId);
      if (!runtime?.socket?.connected) {
        return { channel: CHANNEL_ID, ok: false, error: "aeion gateway is not connected" };
      }

      try {
        return await runtime.sendMessage({ text }, target.botId, target.roomId);
      } catch (err) {
        return { channel: CHANNEL_ID, ok: false, error: err.message || String(err) };
      }
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const target = parseAeionTarget(to);
      if (!target.ok) {
        return { channel: CHANNEL_ID, ok: false, error: target.error.message };
      }

      const runtime = getActiveRuntime(accountId);
      if (!runtime?.socket?.connected) {
        return { channel: CHANNEL_ID, ok: false, error: "aeion gateway is not connected" };
      }

      try {
        return await runtime.sendMessage({ text, media: mediaUrl ? [mediaUrl] : [] }, target.botId, target.roomId);
      } catch (err) {
        return { channel: CHANNEL_ID, ok: false, error: err.message || String(err) };
      }
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const accountId = account.accountId || "default";
      const statusSink = (patch) => ctx.setStatus({ accountId, ...patch });

      if (!account.apiKey) {
        ctx.log?.warn("[aeion] Not configured, skipping start");
        statusSink({ running: false, connected: false, lastError: "aeion: apiKey is required" });
        return;
      }

      ctx.log?.info("[aeion] Starting gateway account...");
      statusSink({
        running: true,
        connected: false,
        lastStartAt: new Date().toISOString(),
        lastError: null,
      });

      let runtime = null;
      try {
        runtime = new AeionChannelRuntime(account, ctx.cfg, ctx.log, statusSink);
        activeRuntimes.set(accountId, runtime);
        await runtime.start(ctx.abortSignal);
      } catch (err) {
        ctx.log?.error(`[aeion] Gateway error: ${err.message}`);
        if (!runtime || activeRuntimes.get(accountId) === runtime) {
          statusSink({ running: false, connected: false, lastError: err.message });
        }
        throw err;
      } finally {
        if (!runtime || activeRuntimes.get(accountId) === runtime) {
          statusSink({
            running: false,
            connected: false,
            lastStopAt: new Date().toISOString(),
          });
          activeRuntimes.delete(accountId);
        }
      }
    },
  },
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      connected: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId || "default",
      name: "aeion",
      enabled: true,
      configured: !!account.apiKey,
      dmPolicy: account.dmPolicy,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
};
