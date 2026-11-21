/**
 * Fake official QQ bot API (token, /gateway, WebSocket gateway, message APIs)
 * for local testing. Enforces the rules that matter to the bot: Authorization
 * header, no links in content (40054010), unique msg_id + msg_seq (40054005),
 * at most 5 passive replies per message (40034128).
 *
 *   node scripts/mock-qqbot.ts                     # interactive: g|@|o|p|a <text> on stdin
 *   node scripts/mock-qqbot.ts --scenario          # scripted run, incl. disconnect + resume
 *   node scripts/mock-qqbot.ts --persona-scenario  # needs pi-persona loaded in the daemon
 *
 * Daemon config: adapter "qqbot", qqbot { appId "mock-app", appSecret "mock-secret",
 * apiBase "http://127.0.0.1:$MOCK_PORT" }, allowedGroups ["123456"], admins ["10000"].
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { type EmitKind, Harness, IDS, NAMES, runFromArgs, sleep } from "./scenario.ts";

const PORT = Number(process.env.MOCK_PORT ?? 3002);
const APP_ID = "mock-app";
const SECRET = "mock-secret";
const BOT_OPENID = "BOTOPENID";
const GROUP_AND_C2C = 1 << 25;

let tokenN = 0;
const validTokens = new Set<string>();
let msgN = 0;
let sessionN = 0;
const usedSeq = new Set<string>();
const passiveCount = new Map<string, number>();
let client: { ws: WebSocket; s: number; sessionId: string; identified: boolean } | undefined;
let resumes = 0;
let nonPassiveSends = 0;

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	let raw = "";
	for await (const chunk of req) raw += chunk;
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function dispatch(t: string, d: unknown): void {
	if (!client?.identified) return;
	client.s += 1;
	client.ws.send(JSON.stringify({ op: 0, s: client.s, t, d }));
}

function emit(kind: EmitKind, text: string): void {
	const id = `msg-${++msgN}`;
	const timestamp = new Date().toISOString();
	if (kind === "p" || kind === "a") {
		const uid = kind === "a" ? IDS.admin : IDS.user2;
		dispatch("C2C_MESSAGE_CREATE", { id, content: text, timestamp, author: { user_openid: uid, id: uid, username: NAMES[uid] } });
		return;
	}
	const group_openid = kind === "o" ? IDS.otherGroup : IDS.group;
	const author = { member_openid: IDS.user, union_openid: `union-${IDS.user}`, member_nickname: NAMES[IDS.user] };
	if (kind === "@") {
		// An @ message arrives twice: as an @ event and as a full-mode event (same id).
		dispatch("GROUP_AT_MESSAGE_CREATE", { id, group_openid, content: ` ${text}`, timestamp, author });
		dispatch("GROUP_MESSAGE_CREATE", {
			id,
			group_openid,
			content: `<@${BOT_OPENID}> ${text}`,
			timestamp,
			author,
			mentions: [{ member_openid: BOT_OPENID, is_you: true, bot: true }],
		});
	} else {
		dispatch("GROUP_MESSAGE_CREATE", { id, group_openid, content: text, timestamp, author });
	}
}

const harness = new Harness(emit, () => client?.identified === true);

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
	if (req.method === "POST" && url.pathname === "/app/getAppAccessToken") {
		const body = await readBody(req);
		if (body.appId !== APP_ID || body.clientSecret !== SECRET) return json(res, 200, { code: 100016, message: "invalid appid or secret" });
		const token = `tok-${++tokenN}`;
		validTokens.add(token);
		return json(res, 200, { access_token: token, expires_in: "7200" });
	}
	const auth = req.headers.authorization ?? "";
	if (!auth.startsWith("QQBot ") || !validTokens.has(auth.slice(6))) return json(res, 401, { code: 11241, message: "unauthorized" });

	if (req.method === "GET" && url.pathname === "/gateway") return json(res, 200, { url: `ws://127.0.0.1:${PORT}/websocket` });

	const m = /^\/v2\/(groups|users)\/([^/]+)\/messages$/.exec(url.pathname);
	if (req.method === "POST" && m) {
		const body = await readBody(req);
		const content = String(body.content ?? "");
		if (body.msg_type !== 0 || !content) return json(res, 400, { err_code: 22006, message: "msg_type/content mismatch" });
		if (/https?:\/\/|\b[a-z0-9-]+\.(com|cn|net|org)\b/i.test(content)) return json(res, 400, { err_code: 40054010, message: "url not allowed" });
		const msgId = typeof body.msg_id === "string" ? body.msg_id : undefined;
		if (msgId) {
			const key = `${msgId}#${body.msg_seq ?? 1}`;
			if (usedSeq.has(key)) return json(res, 400, { err_code: 40054005, message: "duplicate msg_seq" });
			const n = (passiveCount.get(msgId) ?? 0) + 1;
			if (n > 5) return json(res, 400, { err_code: 40034128, message: "passive reply limit" });
			usedSeq.add(key);
			passiveCount.set(msgId, n);
		} else {
			nonPassiveSends += 1;
		}
		harness.record({ scope: m[1] === "groups" ? "group" : "private", id: decodeURIComponent(m[2]), text: content, replyTo: msgId });
		return json(res, 200, { id: `sent-${Date.now()}`, timestamp: new Date().toISOString() });
	}
	json(res, 404, { code: 404, message: "not found" });
});

const wss = new WebSocketServer({ server, path: "/websocket" });
wss.on("connection", (ws) => {
	ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 5000 } }));
	ws.on("message", (raw) => {
		const p = JSON.parse(raw.toString()) as { op: number; d: Record<string, unknown> };
		const tokenOk = typeof p.d?.token === "string" && validTokens.has(String(p.d.token).replace(/^QQBot /, ""));
		if (p.op === 2) {
			if (!tokenOk) return ws.close(4004, "auth failed");
			if ((Number(p.d.intents) & GROUP_AND_C2C) === 0) return ws.close(4014, "intent");
			client = { ws, s: 1, sessionId: `session-${++sessionN}`, identified: true };
			console.log(`client identified (${client.sessionId}, intents ${p.d.intents})`);
			ws.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { version: 1, session_id: client.sessionId, user: { id: BOT_OPENID, username: "PiBot", bot: true }, shard: [0, 1] } }));
		} else if (p.op === 6) {
			const prev = client;
			if (!tokenOk || !prev || p.d.session_id !== prev.sessionId) return ws.send(JSON.stringify({ op: 9, d: false }));
			client = { ws, s: Number(p.d.seq), sessionId: prev.sessionId, identified: true };
			resumes += 1;
			console.log(`client resumed (${client.sessionId} from seq ${p.d.seq})`);
			client.s += 1;
			ws.send(JSON.stringify({ op: 0, s: client.s, t: "RESUMED", d: "" }));
		} else if (p.op === 1) {
			ws.send(JSON.stringify({ op: 11 }));
		}
	});
	ws.on("close", () => {
		if (client?.ws === ws) client.identified = false;
	});
});

server.listen(PORT, () => console.log(`mock QQ bot API on http://127.0.0.1:${PORT}`));

runFromArgs(harness, {
	afterFirstStep: async () => {
		// Drop the connection with a resumable code; the bot must resume the same session.
		console.log("--- forcing disconnect (4009) ---");
		client?.ws.close(4009, "session timed out");
		for (let i = 0; i < 50 && !(client?.identified && resumes > 0); i++) await sleep(200);
		return ["reconnected and resumed the session", resumes > 0 && client?.identified === true];
	},
	finalChecks: () => [["every reply was a passive reply (msg_id set)", nonPassiveSends === 0]],
});
