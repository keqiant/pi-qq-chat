/**
 * Fake OneBot v11 forward-WebSocket server for local testing.
 *
 *   node scripts/mock-onebot.ts                     # interactive: g|@|o|p|a <text> on stdin
 *   node scripts/mock-onebot.ts --scenario          # scripted end-to-end run
 *   node scripts/mock-onebot.ts --persona-scenario  # needs pi-persona loaded in the daemon
 *
 * Daemon config: adapter "onebot", onebot.url ws://127.0.0.1:$MOCK_PORT,
 * allowedGroups ["123456"], admins ["10000"]. See scripts/scenario.ts.
 */
import { WebSocketServer, type WebSocket } from "ws";
import { type EmitKind, Harness, IDS, NAMES, runFromArgs } from "./scenario.ts";

const PORT = Number(process.env.MOCK_PORT ?? 3001);
const SELF_ID = 88888;

let msgId = 1;
const clients = new Set<WebSocket>();

function emit(kind: EmitKind, text: string): void {
	const segments: { type: string; data: Record<string, unknown> }[] = [];
	if (kind === "@") segments.push({ type: "at", data: { qq: String(SELF_ID) } });
	segments.push({ type: "text", data: { text } });
	const isGroup = kind === "g" || kind === "@" || kind === "o";
	const userId = Number(kind === "a" ? IDS.admin : kind === "p" ? IDS.user2 : IDS.user);
	const event = {
		post_type: "message",
		message_type: isGroup ? "group" : "private",
		sub_type: isGroup ? "normal" : "friend",
		message_id: msgId++,
		user_id: userId,
		group_id: isGroup ? Number(kind === "o" ? IDS.otherGroup : IDS.group) : undefined,
		self_id: SELF_ID,
		time: Math.floor(Date.now() / 1000),
		message: segments,
		raw_message: text,
		sender: { user_id: userId, nickname: NAMES[String(userId)] },
	};
	for (const c of clients) c.send(JSON.stringify(event));
}

const harness = new Harness(emit, () => clients.size > 0);

const wss = new WebSocketServer({ port: PORT });
console.log(`mock OneBot listening on ws://127.0.0.1:${PORT}`);

wss.on("connection", (ws, req) => {
	console.log(`client connected (auth: ${req.headers.authorization ?? "none"})`);
	clients.add(ws);
	ws.on("close", () => clients.delete(ws));
	ws.on("message", (raw) => {
		const { action, params, echo } = JSON.parse(raw.toString()) as {
			action: string;
			params: Record<string, unknown>;
			echo: string;
		};
		let data: unknown = null;
		if (action === "get_login_info") data = { user_id: SELF_ID, nickname: "PiBot" };
		if (action === "send_group_msg" || action === "send_private_msg") {
			const message = params.message as { type: string; data: Record<string, unknown> }[];
			const reply = message.find((s) => s.type === "reply");
			harness.record({
				scope: action === "send_group_msg" ? "group" : "private",
				id: String(action === "send_group_msg" ? params.group_id : params.user_id),
				text: message.map((s) => (s.type === "text" ? String(s.data.text) : "")).join(""),
				replyTo: reply ? String(reply.data.id) : undefined,
			});
			data = { message_id: msgId++ };
		}
		ws.send(JSON.stringify({ status: "ok", retcode: 0, data, echo }));
	});
});

runFromArgs(harness);
