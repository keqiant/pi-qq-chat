/**
 * Thin wrapper over Node's built-in WebSocket client (Node >= 22), so the bot
 * has no runtime npm dependencies. Node's client accepts a non-standard
 * `{ headers }` option, which OneBot needs for its access token.
 */

export interface Socket {
	readonly isOpen: boolean;
	send(data: string): void;
	/** Codes must be 1000 or 3000–4999 (WHATWG WebSocket rule). */
	close(code?: number, reason?: string): void;
}

export interface SocketHandlers {
	onOpen?(): void;
	onMessage(text: string): void;
	onClose(code: number): void;
	onError?(message: string): void;
}

type NodeWebSocketCtor = new (url: string, options?: { headers?: Record<string, string> }) => WebSocket;

export function openSocket(url: string, handlers: SocketHandlers, headers?: Record<string, string>): Socket {
	const Ctor = (globalThis as { WebSocket?: unknown }).WebSocket as NodeWebSocketCtor | undefined;
	if (!Ctor) throw new Error("pi-qq: this Node.js has no built-in WebSocket; use Node 22 or newer");
	const ws = headers && Object.keys(headers).length > 0 ? new Ctor(url, { headers }) : new Ctor(url);
	ws.binaryType = "arraybuffer";
	const decoder = new TextDecoder();
	ws.addEventListener("open", () => handlers.onOpen?.());
	ws.addEventListener("message", (ev) => {
		const data = (ev as MessageEvent).data as unknown;
		handlers.onMessage(typeof data === "string" ? data : decoder.decode(data as ArrayBuffer));
	});
	ws.addEventListener("close", (ev) => handlers.onClose((ev as CloseEvent).code));
	ws.addEventListener("error", (ev) => handlers.onError?.(((ev as ErrorEvent).message || "websocket error").toString()));
	return {
		get isOpen() {
			return ws.readyState === 1;
		},
		send: (data) => ws.send(data),
		close: (code, reason) => {
			try {
				ws.close(code, reason);
			} catch {
				ws.close();
			}
		},
	};
}
