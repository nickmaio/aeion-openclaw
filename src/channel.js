import { fetch } from "undici";
import { io } from "socket.io-client";
import { getAeionRuntime } from "./runtime.js";

const CHANNEL_ID = "aeion";
const AEION_SERVER_URL = "https://api.aeion.org";
const TYPING_REFRESH_MS = 4000;
const INBOUND_DEDUPE_TTL_MS = 10 * 60 * 1000;
const INBOUND_DEDUPE_MAX = 1000;
const OUTBOUND_ECHO_TTL_MS = 2 * 60 * 1000;
const OUTBOUND_ECHO_MAX = 500;
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

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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

function getInboundMessageKey(payload, sender, route) {
  const messageId = firstString(payload?._id, payload?.id, payload?.messageId, payload?.message_id);
  if (messageId) return `id:${messageId}`;

  const createdAt = firstString(payload?.ts, payload?.t, payload?.createdAt, payload?.created_at);
  const body = asString(payload?.m);
  return `fallback:${route.sessionKey}:${sender.id}:${createdAt}:${body}`;
}

function getMessageBody(payload) {
  return asString(payload?.m || payload?.text || payload?.body).trim();
}

function getOutboundEchoKey(routeOrTarget, text) {
  const botId = asString(routeOrTarget?.botId);
  const roomId = asString(routeOrTarget?.roomId);
  const sessionKey = roomId ? `${botId}:${roomId}` : botId;
  return `${sessionKey}:${asString(text).trim()}`;
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
    this.manualReconnectTimer = null;
    this.manualReconnectAttempts = 0;
    this.resolveStop = null;
    this.stopping = false;
    this.hasConnected = false;
    this.activeRuns = 0;
    this.typingIntervals = new Map();
    this.recentInboundMessages = new Map();
    this.recentOutboundEchoes = new Map();
  }

  async start(abortSignal) {
    try {
      const { apiKey } = this.account;
      this.log?.info(`[aeion] Starting connection with API key: ${apiKey ? apiKey.substring(0, 3) + "..." : "MISSING"}`);

      if (!apiKey) {
        throw new Error("aeion: apiKey is required");
      }

      this.socket = io(AEION_SERVER_URL, {
        transports: ["websocket", "polling"],
        auth: { token: "bearer " + apiKey, agent: "OpenClaw", platform: "aeion" },
        withCredentials: true,
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
      });

      await new Promise((resolve, reject) => {
        const connectTimeout = setTimeout(() => {
          reject(new Error("Socket connection timeout after 10 seconds"));
        }, 10000);

        this.socket.on("connect", () => {
          clearTimeout(connectTimeout);
          this.hasConnected = true;
          this.manualReconnectAttempts = 0;
          this.clearManualReconnectTimer();
          this.statusSink?.({
            running: true,
            connected: true,
            reconnecting: false,
            disconnectReason: null,
            lastTransportActivityAt: Date.now(),
            lastError: null,
          });
          this.log?.info("[aeion] Connected to aeion API server");
          resolve();
        });

        this.socket.on("connect_error", (err) => {
          clearTimeout(connectTimeout);
          if (this.hasConnected) {
            this.statusSink?.({
              reconnecting: true,
              lastTransportActivityAt: Date.now(),
              lastError: err.message,
            });
          } else {
            this.statusSink?.({ connected: false, reconnecting: false, lastError: err.message });
          }
          this.log?.error(`[aeion] Connection Error: ${err.message}`);
          if (!this.hasConnected) reject(err);
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

      this.socket.on("disconnect", (reason, details) => {
        this.handleDisconnect(reason, details);
      });

      this.socket.io.on("reconnect_attempt", (attempt) => {
        this.log?.info(`[aeion] Reconnect attempt ${attempt}`);
      });

      this.socket.io.on("reconnect", (attempt) => {
        this.manualReconnectAttempts = 0;
        this.clearManualReconnectTimer();
        this.statusSink?.({
          running: true,
          connected: true,
          reconnecting: false,
          disconnectReason: null,
          lastTransportActivityAt: Date.now(),
          lastError: null,
        });
        this.log?.info(`[aeion] Reconnected after ${attempt} attempt(s)`);
      });

      this.socket.io.on("reconnect_error", (err) => {
        this.statusSink?.({
          reconnecting: true,
          lastTransportActivityAt: Date.now(),
          lastError: err.message,
        });
        this.log?.warn(`[aeion] Reconnect error: ${err.message}`);
      });

      this.socket.io.on("reconnect_failed", () => {
        this.clearManualReconnectTimer();
        this.statusSink?.({
          connected: false,
          reconnecting: false,
          lastTransportActivityAt: Date.now(),
          lastError: "Socket.IO reconnect failed",
        });
        this.log?.error("[aeion] Reconnect failed");
        this.resolveStop?.();
      });

      this.log?.info("[aeion] Socket fully initialized and listening for messages");

      await new Promise((resolve) => {
        this.resolveStop = resolve;
        if (abortSignal.aborted) {
          this.stopping = true;
          resolve();
          return;
        }

        abortSignal.addEventListener("abort", () => {
          this.stopping = true;
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
      this.statusSink?.({ lastInboundAt: Date.now(), lastTransportActivityAt: Date.now() });
      const sender = normalizeAeionSender(payload?.by);
      const route = normalizeAeionRoute(payload);
      if (this.isOwnMessage(sender, route)) {
        this.log?.info("[aeion] Ignoring own message");
        return;
      }

      if (this.isOutboundEcho(payload, route)) {
        this.log?.info("[aeion] Ignoring echoed outbound message");
        return;
      }

      if (!this.isInboundAllowed(payload)) {
        this.log?.warn("[aeion] Inbound message blocked by dmSecurity policy");
        return;
      }

      if (this.isDuplicateInbound(payload, sender, route)) {
        this.log?.info("[aeion] Ignoring duplicate inbound message");
        return;
      }

      this.log?.info("[aeion] Inbound message received");

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
        this.markRunActivity(1);
        this.startTyping(route.botId, route.roomId);
        await core.channel.reply.dispatchReplyFromConfig({
          ctx: finalContext,
          cfg: this.cfg,
          dispatcher,
          replyOptions,
        });
      } finally {
        this.markRunActivity(-1);
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

  isOwnMessage(sender, route) {
    const senderId = normalizeAllowValue(sender?.id);
    if (!senderId) return false;

    const ownIds = [
      this.account.accountId,
      this.account.botId,
      route.botId,
      this.socket?.id,
    ].map(normalizeAllowValue).filter(Boolean);

    return ownIds.includes(senderId);
  }

  isDuplicateInbound(payload, sender, route) {
    const now = Date.now();
    this.pruneInboundDedupe(now);

    const key = getInboundMessageKey(payload, sender, route);
    if (this.recentInboundMessages.has(key)) return true;

    this.recentInboundMessages.set(key, now);
    return false;
  }

  isOutboundEcho(payload, route) {
    const now = Date.now();
    this.pruneOutboundEchoes(now);

    const key = getOutboundEchoKey(route, getMessageBody(payload));
    if (!this.recentOutboundEchoes.has(key)) return false;

    this.recentOutboundEchoes.delete(key);
    return true;
  }

  pruneInboundDedupe(now = Date.now()) {
    for (const [key, seenAt] of this.recentInboundMessages) {
      if (now - seenAt > INBOUND_DEDUPE_TTL_MS) {
        this.recentInboundMessages.delete(key);
      }
    }

    while (this.recentInboundMessages.size > INBOUND_DEDUPE_MAX) {
      const oldestKey = this.recentInboundMessages.keys().next().value;
      if (!oldestKey) break;
      this.recentInboundMessages.delete(oldestKey);
    }
  }

  rememberOutboundEcho(botId, roomId, text) {
    const now = Date.now();
    this.pruneOutboundEchoes(now);
    this.recentOutboundEchoes.set(getOutboundEchoKey({ botId, roomId }, text), now);
  }

  pruneOutboundEchoes(now = Date.now()) {
    for (const [key, seenAt] of this.recentOutboundEchoes) {
      if (now - seenAt > OUTBOUND_ECHO_TTL_MS) {
        this.recentOutboundEchoes.delete(key);
      }
    }

    while (this.recentOutboundEchoes.size > OUTBOUND_ECHO_MAX) {
      const oldestKey = this.recentOutboundEchoes.keys().next().value;
      if (!oldestKey) break;
      this.recentOutboundEchoes.delete(oldestKey);
    }
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
        this.log?.info("[aeion] Downloading inbound attachment");
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
        this.log?.info("[aeion] Inbound attachment saved");
      } catch (err) {
        this.log?.error(`[aeion] Failed to download inbound attachment: ${err.message}`);
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
        if (mediaSpecs.length > 0) {
          throw new Error("aeion outbound media attachments require a safe media loader");
        }
        this.log?.info("[aeion] Skipping empty message");
        return { channel: CHANNEL_ID, ok: true, skipped: true };
      }

      this.log?.info("[aeion] Sending outbound message");
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
        this.log?.info("[aeion] Converted room id for msg_send");
      }

      this.rememberOutboundEcho(botId, roomId, msgPayload.m);
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

  markRunActivity(delta) {
    this.activeRuns = Math.max(0, this.activeRuns + delta);
    this.statusSink?.({
      busy: this.activeRuns > 0,
      activeRuns: this.activeRuns,
      lastRunActivityAt: Date.now(),
    });
  }

  handleDisconnect(reason, details) {
    const detailText = details ? ` ${safeJson(details)}` : "";
    this.log?.warn(`[aeion] Disconnected from aeion API server: ${reason || "unknown"}${detailText}`);

    if (this.stopping) return;

    this.statusSink?.({
      running: true,
      reconnecting: true,
      disconnectReason: reason || "unknown",
      lastDisconnectAt: Date.now(),
      lastTransportActivityAt: Date.now(),
    });

    if (reason === "io server disconnect") {
      this.scheduleManualReconnect();
    }
  }

  scheduleManualReconnect() {
    if (!this.socket || this.socket.connected || this.manualReconnectTimer) return;

    this.manualReconnectAttempts += 1;
    const delayMs = Math.min(30_000, 1000 * (2 ** Math.min(this.manualReconnectAttempts - 1, 5)));
    this.log?.warn(`[aeion] Server disconnected the socket; reconnecting manually in ${Math.round(delayMs / 1000)}s`);

    this.manualReconnectTimer = setTimeout(() => {
      this.manualReconnectTimer = null;
      if (this.stopping || !this.socket || this.socket.connected) return;
      this.log?.info("[aeion] Manual Socket.IO reconnect attempt");
      this.socket.connect();
    }, delayMs);
  }

  clearManualReconnectTimer() {
    if (this.manualReconnectTimer) {
      clearTimeout(this.manualReconnectTimer);
      this.manualReconnectTimer = null;
    }
  }

  async buildOutboundAttachments(mediaSpecs) {
    for (const media of mediaSpecs) {
      this.log?.warn("[aeion] Skipping outbound media attachment; safe outbound media loading is not available yet");
    }
    return [];
  }

  startTyping(botId, roomId) {
    this.emitTyping("typing", botId, roomId);
    const key = this.typingKey(botId, roomId);
    if (this.typingIntervals.has(key)) return;

    const interval = setInterval(() => {
      this.emitTyping("typing", botId, roomId);
    }, TYPING_REFRESH_MS);
    if (typeof interval === "object" && "unref" in interval) interval.unref();
    this.typingIntervals.set(key, interval);
  }

  stopTyping(botId, roomId) {
    const key = this.typingKey(botId, roomId);
    const interval = this.typingIntervals.get(key);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(key);
    }
    this.emitTyping("typing_stop", botId, roomId);
  }

  emitTyping(eventName, botId, roomId) {
    const socket = this.getConnectedSocket();
    if (!socket) return false;
    const payload = { to: botId };
    if (roomId) payload.td = toSocketRoomId(roomId);
    socket.emit(eventName, payload);
    this.statusSink?.({ lastTransportActivityAt: Date.now() });
    return true;
  }

  typingKey(botId, roomId) {
    return `${botId || "unknown"}:${roomId || "main"}`;
  }

  stopAllTyping() {
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
  }

  async stop() {
    this.log?.info("[aeion] Stopping...");
    this.stopping = true;
    this.resolveStop?.();
    this.resolveStop = null;
    this.clearManualReconnectTimer();
    this.stopAllTyping();
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
        botId: aeionCfg.botId || aeionCfg.screenId || aeionCfg.agentId,
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
        statusSink({ running: false, connected: false, reconnecting: false, lastError: "aeion: apiKey is required" });
        return;
      }

      ctx.log?.info("[aeion] Starting gateway account...");
      statusSink({
        running: true,
        connected: false,
        reconnecting: false,
        lastStartAt: Date.now(),
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
          statusSink({ running: false, connected: false, reconnecting: false, lastError: err.message });
        }
        throw err;
      } finally {
        if (!runtime || activeRuntimes.get(accountId) === runtime) {
          statusSink({
            running: false,
            connected: false,
            reconnecting: false,
            lastStopAt: Date.now(),
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
      reconnecting: false,
      lastDisconnectAt: null,
      disconnectReason: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      busy: false,
      activeRuns: 0,
      lastRunActivityAt: null,
      lastTransportActivityAt: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId || "default",
      name: "aeion",
      enabled: true,
      configured: !!account.apiKey,
      dmPolicy: account.dmPolicy,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      reconnecting: runtime?.reconnecting ?? false,
      lastDisconnectAt: runtime?.lastDisconnectAt ?? null,
      disconnectReason: runtime?.disconnectReason ?? null,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      busy: runtime?.busy ?? false,
      activeRuns: runtime?.activeRuns ?? 0,
      lastRunActivityAt: runtime?.lastRunActivityAt ?? null,
      lastTransportActivityAt: runtime?.lastTransportActivityAt ?? null,
    }),
  },
};
