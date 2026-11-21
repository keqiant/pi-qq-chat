/**
 * Official QQ bot (QQ 开放平台, q.qq.com) transport over the WebSocket gateway.
 *
 * - Access token: POST {apiBase}/app/getAppAccessToken, refreshed before expiry
 * - Gateway: GET {apiBase}/gateway → wss URL; Hello / Identify / Heartbeat / Resume
 * - Events: GROUP_AT_MESSAGE_CREATE, GROUP_MESSAGE_CREATE (group "receive all
 *   messages" mode), C2C_MESSAGE_CREATE
 * - Sending: POST /v2/groups/{group_openid}/messages and /v2/users/{openid}/messages,
 *   as passive replies (msg_id + msg_seq) whenever a message ID is known
 */
import { sanitizeUrls } from "./message.ts";
import type { ChatTarget } from "./queue.ts";
import type { ChatTransport, IncomingMessage, SendOptions, TransportHandlers } from "./transport.ts";
import { openSocket, type Socket } from "./ws.ts";

export interface QQBotOptions {
	appId: string;
	appSecret: string;
	apiBase: string;
	intents: number;
}

export class QQBotApiError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(`${message} (code ${code})`);
		this.code = code;
	}
}

/** Passive reply no longer possible (expired / reply count used up / unknown msg_id). */
const PASSIVE_UNAVAILABLE = new Set([304103, 40034005, 40034024, 40034128]);
/** Same msg_id + msg_seq already sent. */
const DUPLICATE_SEQ = 40054005;
/** Close codes after which reconnecting is pointless. */
const FATAL_CLOSE = new Set([4914, 4915]);
/** Close codes that invalidate the session (identify again instead of resuming). */
const NEW_SESSION_CLOSE = new Set([4006, 4007, 4010, 4011, 4012, 4013, 4014]);

interface Author {
	id?: string;
	username?: string;
	bot?: boolean;
	union_openid?: string;
	member_openid?: string;
	user_openid?: string;
	member_nickname?: string;
}

interface Mention {
	id?: string;
	username?: string;
	member_openid?: string;
	member_nickname?: string;
	is_you?: boolean;
	scope?: string;
}

interface Attachment {
	url?: string;
	filename?: string;
	content_type?: string;
	asr_refer_text?: string;
}

export interface QQMessageEventData {
	id: string;
	author?: Author;
	content?: string;
	timestamp?: string;
	message_type?: number;
	group_openid?: string;
	mentions?: Mention[];
	attachments?: Attachment[];
}

function normalizeUrl(url: string): string {
	if (url.startsWith("//")) return `https:${url}`;
	if (!/^[a-z]+:\/\//i.test(url)) return `https://${url}`;
	return url;
}

/** Turn an official-bot message event into an IncomingMessage (exported for tests). */
export function normalizeEvent(type: string, d: QQMessageEventData): IncomingMessage | undefined {
	const author = d.author ?? {};
	if (author.bot) return undefined;
	const isGroup = type !== "C2C_MESSAGE_CREATE";
	const userId = (isGroup ? author.member_openid : author.user_openid) ?? author.id ?? "";
	const chatId = isGroup ? d.group_openid : userId;
	if (!userId || !chatId) return undefined;

	let mentionsSelf = type === "GROUP_AT_MESSAGE_CREATE";
	let text = (d.content ?? "")
		.replace(/<faceType=[^>]*>/g, "[表情]")
		.replace(/<@!?([^>\s]+)>/g, (_m, who: string) => {
			if (who === "all" || who === "everyone") return "@全体成员 ";
			const mention = d.mentions?.find((m) => m.member_openid === who || m.id === who);
			if (mention?.is_you) {
				mentionsSelf = true;
				return "@你 ";
			}
			return `@${mention?.member_nickname || mention?.username || "某人"} `;
		})
		.replace(/[ \t]{2,}/g, " ")
		.trim();
	if (type === "GROUP_AT_MESSAGE_CREATE" && !text.startsWith("@你")) text = `@你 ${text}`.trim();
	if (d.message_type === 103) text = `[回复某条消息] ${text}`;

	const imageUrls: string[] = [];
	for (const a of d.attachments ?? []) {
		const ct = a.content_type ?? "";
		if (ct.startsWith("image")) {
			if (a.url) imageUrls.push(normalizeUrl(a.url));
			text += "[图片]";
		} else if (ct === "voice" || ct.startsWith("audio")) {
			text += a.asr_refer_text ? `[语音：${a.asr_refer_text}]` : "[语音]";
		} else if (ct.startsWith("video")) {
			text += "[视频]";
		} else {
			text += `[文件 ${a.filename ?? ""}]`.replace(" ]", "]");
		}
	}

	const parsed = d.timestamp ? Date.parse(d.timestamp) : Number.NaN;
	return {
		target: { kind: isGroup ? "group" : "private", id: chatId },
		userId,
		userIds: [author.member_openid, author.user_openid, author.id, author.union_openid].filter(
			(v): v is string => typeof v === "string" && v !== "",
		),
		userName: (isGroup ? author.member_nickname : undefined) || author.username || (isGroup ? "群友" : "用户"),
		text: text.trim(),
		imageUrls,
		mentionsSelf,
		messageId: d.id,
		time: Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000),
	};
}

export class QQBotTransport implements ChatTransport {
	readonly name = "qqbot";
	readonly promptHints: readonly string[] = [
		"这是 QQ 官方机器人：你看不到群友的 QQ 号，括号里是平台分配的匿名 ID 缩写。",
		"不要在回复里写网址或域名，平台会拒绝发送带链接的消息。",
	];
	private readonly opts: QQBotOptions;
	private readonly handlers: TransportHandlers;
	private ws: Socket | undefined;
	private ready = false;
	private closed = true;
	private backoffMs = 1000;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private sessionId: string | undefined;
	private seq: number | null = null;
	private token: { value: string; expiresAt: number } | undefined;
	private tokenPromise: Promise<string> | undefined;
	/** Recently seen message IDs (pushes can repeat, and @ messages may arrive as two events). */
	private readonly seen = new Map<string, number>();
	/** Next msg_seq per replied-to msg_id. */
	private readonly replySeq = new Map<string, number>();

	constructor(options: QQBotOptions, handlers: TransportHandlers) {
		this.opts = options;
		this.handlers = handlers;
	}

	private log(msg: string): void {
		this.handlers.log(`[qqbot] ${msg}`);
	}

	get connected(): boolean {
		return this.ready && this.ws?.isOpen === true;
	}

	displayUserId(id: string): string {
		return id.slice(0, 6);
	}

	displayChatId(target: ChatTarget): string {
		return target.id.slice(0, 8);
	}

	// ---- access token & HTTP API ------------------------------------------

	private async getToken(): Promise<string> {
		const t = this.token;
		// A new token is only issued within the last 60 s of the old one's lifetime.
		if (t && Date.now() < t.expiresAt - 50_000) return t.value;
		this.tokenPromise ??= this.fetchToken().finally(() => {
			this.tokenPromise = undefined;
		});
		return this.tokenPromise;
	}

	private async fetchToken(): Promise<string> {
		const res = await fetch(`${this.opts.apiBase}/app/getAppAccessToken`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ appId: this.opts.appId, clientSecret: this.opts.appSecret }),
			signal: AbortSignal.timeout(15_000),
		});
		const body = (await res.json()) as { access_token?: string; expires_in?: number | string; code?: number; message?: string };
		if (!body.access_token) throw new QQBotApiError(Number(body.code ?? res.status), `getAppAccessToken failed: ${body.message ?? res.statusText}`);
		const ttl = Number(body.expires_in ?? 7200);
		this.token = { value: body.access_token, expiresAt: Date.now() + (Number.isFinite(ttl) ? ttl : 7200) * 1000 };
		return body.access_token;
	}

	private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
		const token = await this.getToken();
		const res = await fetch(`${this.opts.apiBase}${path}`, {
			method,
			headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(20_000),
		});
		const text = await res.text();
		let data: Record<string, unknown> = {};
		try {
			data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
		} catch {
			/* non-JSON body */
		}
		const code = Number(data.err_code ?? data.code ?? 0);
		if (!res.ok || code !== 0) {
			throw new QQBotApiError(code || res.status, String(data.message ?? res.statusText ?? "request failed"));
		}
		return data as T;
	}

	// ---- gateway ------------------------------------------------------------

	start(): void {
		if (!this.closed) return;
		this.closed = false;
		void this.connect();
	}

	stop(): void {
		this.closed = true;
		this.ready = false;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.stopHeartbeat();
		this.ws?.close(1000);
		this.ws = undefined;
	}

	private scheduleReconnect(delayMs = this.backoffMs): void {
		if (this.closed) return;
		this.log(`reconnecting in ${delayMs}ms`);
		this.reconnectTimer = setTimeout(() => void this.connect(), delayMs);
		this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
	}

	private async connect(): Promise<void> {
		if (this.closed) return;
		let url: string;
		try {
			await this.getToken();
			url = (await this.api<{ url: string }>("GET", "/gateway")).url;
		} catch (err) {
			this.log(`cannot reach gateway: ${(err as Error).message}`);
			this.scheduleReconnect();
			return;
		}
		let ws: Socket;
		try {
			ws = openSocket(url, {
				onMessage: (text) => {
					let payload: { op: number; d?: unknown; s?: number; t?: string };
					try {
						payload = JSON.parse(text) as typeof payload;
					} catch {
						return;
					}
					void this.onPayload(ws, payload);
				},
				onClose: (code) => this.onClose(ws, code),
				onError: (msg) => this.log(`websocket error: ${msg}`),
			});
		} catch (err) {
			this.log(`cannot connect: ${(err as Error).message}`);
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;
	}

	private sendRaw(ws: Socket, payload: unknown): void {
		if (ws.isOpen) ws.send(JSON.stringify(payload));
	}

	private async onPayload(ws: Socket, p: { op: number; d?: unknown; s?: number; t?: string }): Promise<void> {
		if (typeof p.s === "number") this.seq = p.s;
		switch (p.op) {
			case 10: {
				const interval = Number((p.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 45_000);
				this.startHeartbeat(ws, interval);
				const token = `QQBot ${await this.getToken()}`;
				if (this.sessionId && this.seq !== null) {
					this.sendRaw(ws, { op: 6, d: { token, session_id: this.sessionId, seq: this.seq } });
				} else {
					this.sendRaw(ws, {
						op: 2,
						d: {
							token,
							intents: this.opts.intents,
							shard: [0, 1],
							properties: { $os: process.platform, $browser: "pi-qq-chat", $device: "pi-qq-chat" },
						},
					});
				}
				break;
			}
			case 0:
				this.onDispatch(p.t ?? "", p.d);
				break;
			case 7: // server asks us to reconnect (and resume)
				this.log("server requested reconnect");
				ws.close(4000);
				break;
			case 9: // invalid session
				this.log("invalid session, identifying again");
				this.sessionId = undefined;
				this.seq = null;
				ws.close(4000);
				break;
			default:
				break; // 11 heartbeat ACK etc.
		}
	}

	private onDispatch(type: string, d: unknown): void {
		if (type === "READY") {
			const ready = d as { session_id?: string; user?: { id?: string; username?: string } };
			this.sessionId = ready.session_id;
			this.ready = true;
			this.backoffMs = 1000;
			this.log(`connected, logged in as ${ready.user?.username ?? "?"} (${ready.user?.id ?? "?"})`);
			return;
		}
		if (type === "RESUMED") {
			this.ready = true;
			this.backoffMs = 1000;
			this.log("connected, session resumed");
			return;
		}
		if (type !== "GROUP_AT_MESSAGE_CREATE" && type !== "GROUP_MESSAGE_CREATE" && type !== "C2C_MESSAGE_CREATE") return;
		const data = d as QQMessageEventData;
		if (!data?.id || this.isDuplicate(data.id)) return;
		const message = normalizeEvent(type, data);
		if (message) this.handlers.onMessage(message);
	}

	private isDuplicate(id: string): boolean {
		const now = Date.now();
		if (this.seen.has(id)) return true;
		this.seen.set(id, now);
		if (this.seen.size > 2000) {
			for (const [k, t] of this.seen) if (now - t > 10 * 60_000 || this.seen.size > 1500) this.seen.delete(k);
		}
		return false;
	}

	private startHeartbeat(ws: Socket, intervalMs: number): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => this.sendRaw(ws, { op: 1, d: this.seq }), intervalMs);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}

	private onClose(ws: Socket, code: number): void {
		if (this.ws !== ws) return;
		this.ws = undefined;
		this.ready = false;
		this.stopHeartbeat();
		if (this.closed) return;
		if (FATAL_CLOSE.has(code)) {
			this.log(`closed with ${code} (bot delisted or banned); not reconnecting`);
			this.closed = true;
			return;
		}
		if (code === 4013 || code === 4014) {
			this.log(`closed with ${code}: the bot lacks permission for the requested intents (group/C2C events need approval on q.qq.com)`);
		} else {
			this.log(`disconnected (${code})`);
		}
		if (NEW_SESSION_CLOSE.has(code) || (code >= 4900 && code <= 4913)) {
			this.sessionId = undefined;
			this.seq = null;
		}
		this.scheduleReconnect(code === 4013 || code === 4014 ? 60_000 : this.backoffMs);
	}

	// ---- sending ------------------------------------------------------------

	private nextSeq(msgId: string): number {
		const n = this.replySeq.get(msgId) ?? 1;
		this.replySeq.set(msgId, n + 1);
		if (this.replySeq.size > 1000) {
			const oldest = this.replySeq.keys().next().value;
			if (oldest !== undefined) this.replySeq.delete(oldest);
		}
		return n;
	}

	async send(target: ChatTarget, chunks: string[], options: SendOptions): Promise<void> {
		const path = target.kind === "group" ? `/v2/groups/${target.id}/messages` : `/v2/users/${target.id}/messages`;
		let replyTo = options.replyTo;
		for (const [i, chunk] of chunks.entries()) {
			const content = sanitizeUrls(chunk);
			const build = (seqRetry = false): Record<string, unknown> => {
				const body: Record<string, unknown> = { msg_type: 0, content };
				if (replyTo) {
					body.msg_id = replyTo;
					body.msg_seq = this.nextSeq(replyTo) + (seqRetry ? 1 : 0);
					if (i === 0 && options.quote) body.message_reference = { message_id: replyTo };
				}
				return body;
			};
			try {
				await this.api("POST", path, build());
			} catch (err) {
				if (!(err instanceof QQBotApiError)) throw err;
				if (replyTo && err.code === DUPLICATE_SEQ) {
					await this.api("POST", path, build(true));
				} else if (replyTo && PASSIVE_UNAVAILABLE.has(err.code)) {
					// Fall back to an active message (needs "主动发言" enabled in the group).
					this.log(`passive reply unavailable (${err.code}); sending as active message`);
					replyTo = undefined;
					await this.api("POST", path, build());
				} else {
					throw err;
				}
			}
		}
	}
}
