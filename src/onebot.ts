import WebSocket from "ws";
import { getSegments, renderSegments } from "./message.ts";
import type { ChatTarget } from "./queue.ts";
import type { ChatTransport, SendOptions, TransportHandlers } from "./transport.ts";

/** One OneBot v11 message segment (array message format). */
export interface Segment {
	type: string;
	data: Record<string, unknown>;
}

export interface Sender {
	user_id: number;
	nickname?: string;
	card?: string;
	role?: string;
}

export interface MessageEvent {
	post_type: "message";
	message_type: "private" | "group";
	sub_type?: string;
	message_id: number;
	user_id: number;
	group_id?: number;
	self_id: number;
	time: number;
	message: Segment[] | string;
	raw_message?: string;
	sender: Sender;
}

interface ActionResponse {
	status: "ok" | "failed" | "async";
	retcode: number;
	data: unknown;
	message?: string;
	wording?: string;
	echo?: string;
}

export interface OneBotClientOptions {
	url: string;
	accessToken?: string;
	onMessage: (event: MessageEvent) => void;
	log?: (msg: string) => void;
	/** Action timeout in ms. */
	timeoutMs?: number;
}

/**
 * Minimal OneBot v11 forward-WebSocket client: receives events and calls
 * actions (matched by `echo`). Reconnects with exponential backoff.
 */
export class OneBotClient {
	private ws: WebSocket | undefined;
	private closed = false;
	private backoffMs = 1000;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private seq = 0;
	private readonly pending = new Map<
		string,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
	>();
	private readonly opts: OneBotClientOptions;
	selfId: number | undefined;

	constructor(opts: OneBotClientOptions) {
		this.opts = opts;
	}

	private log(msg: string): void {
		this.opts.log?.(msg);
	}

	get connected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	start(): void {
		this.closed = false;
		this.connect();
	}

	private connect(): void {
		if (this.closed) return;
		const headers: Record<string, string> = {};
		if (this.opts.accessToken) headers.Authorization = `Bearer ${this.opts.accessToken}`;
		const ws = new WebSocket(this.opts.url, { headers });
		this.ws = ws;

		ws.on("open", () => {
			this.backoffMs = 1000;
			this.log(`connected to ${this.opts.url}`);
			this.call<{ user_id: number; nickname: string }>("get_login_info")
				.then((info) => {
					this.selfId = info.user_id;
					this.log(`logged in as ${info.nickname} (${info.user_id})`);
				})
				.catch((err: Error) => this.log(`get_login_info failed: ${err.message}`));
		});

		ws.on("message", (raw) => {
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(raw.toString()) as Record<string, unknown>;
			} catch {
				return;
			}
			if (typeof data.echo === "string" && this.pending.has(data.echo)) {
				const p = this.pending.get(data.echo)!;
				this.pending.delete(data.echo);
				clearTimeout(p.timer);
				const res = data as unknown as ActionResponse;
				if (res.status === "failed") {
					p.reject(new Error(res.wording || res.message || `retcode ${res.retcode}`));
				} else {
					p.resolve(res.data);
				}
				return;
			}
			if (data.post_type === "message" || data.post_type === "message_sent") {
				if (typeof data.self_id === "number") this.selfId = data.self_id;
				if (data.post_type === "message") {
					try {
						this.opts.onMessage(data as unknown as MessageEvent);
					} catch (err) {
						this.log(`onMessage handler error: ${(err as Error).message}`);
					}
				}
			}
		});

		ws.on("close", (code) => {
			this.failPending(new Error("connection closed"));
			if (this.ws === ws) this.ws = undefined;
			if (this.closed) return;
			this.log(`disconnected (${code}), reconnecting in ${this.backoffMs}ms`);
			this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
			this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
		});

		ws.on("error", (err) => {
			this.log(`websocket error: ${err.message}`);
		});
	}

	private failPending(err: Error): void {
		for (const [echo, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
			this.pending.delete(echo);
		}
	}

	call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("OneBot not connected"));
		}
		const echo = `pi-qq-${++this.seq}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(echo);
				reject(new Error(`${action} timed out`));
			}, this.opts.timeoutMs ?? 30_000);
			this.pending.set(echo, { resolve: resolve as (v: unknown) => void, reject, timer });
			ws.send(JSON.stringify({ action, params, echo }));
		});
	}

	sendGroup(groupId: number, message: Segment[]): Promise<unknown> {
		return this.call("send_group_msg", { group_id: groupId, message });
	}

	sendPrivate(userId: number, message: Segment[]): Promise<unknown> {
		return this.call("send_private_msg", { user_id: userId, message });
	}

	stop(): void {
		this.closed = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.failPending(new Error("client stopped"));
		this.ws?.close();
		this.ws = undefined;
	}
}

function senderName(event: MessageEvent): string {
	const s = event.sender ?? { user_id: event.user_id };
	return (s.card && s.card.trim()) || s.nickname || String(event.user_id);
}

/** OneBot v11 (NapCat / LLOneBot) as a ChatTransport. */
export class OneBotTransport implements ChatTransport {
	readonly name = "onebot";
	readonly promptHints: readonly string[] = [];
	private readonly client: OneBotClient;
	private readonly handlers: TransportHandlers;

	constructor(options: { url: string; accessToken?: string }, handlers: TransportHandlers) {
		this.handlers = handlers;
		this.client = new OneBotClient({
			url: options.url,
			accessToken: options.accessToken,
			onMessage: (e) => this.onEvent(e),
			log: (m) => handlers.log(`[onebot] ${m}`),
		});
	}

	get connected(): boolean {
		return this.client.connected;
	}

	private onEvent(e: MessageEvent): void {
		const selfId = this.client.selfId;
		if (selfId !== undefined && e.user_id === selfId) return;
		const rendered = renderSegments(getSegments(e.message), selfId);
		const target: ChatTarget =
			e.message_type === "group" ? { kind: "group", id: String(e.group_id) } : { kind: "private", id: String(e.user_id) };
		this.handlers.onMessage({
			target,
			userId: String(e.user_id),
			userIds: [String(e.user_id)],
			userName: senderName(e),
			text: rendered.text,
			imageUrls: rendered.imageUrls,
			mentionsSelf: rendered.mentionsSelf,
			messageId: String(e.message_id),
			time: e.time,
		});
	}

	displayUserId(id: string): string {
		return id;
	}

	displayChatId(target: ChatTarget): string {
		return target.id;
	}

	start(): void {
		this.client.start();
	}

	stop(): void {
		this.client.stop();
	}

	async send(target: ChatTarget, chunks: string[], options: SendOptions): Promise<void> {
		for (const [i, chunk] of chunks.entries()) {
			const message: Segment[] = [];
			if (i === 0 && options.quote && options.replyTo) message.push({ type: "reply", data: { id: options.replyTo } });
			message.push({ type: "text", data: { text: chunk } });
			if (target.kind === "group") await this.client.sendGroup(Number(target.id), message);
			else await this.client.sendPrivate(Number(target.id), message);
		}
	}
}
