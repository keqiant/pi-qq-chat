/**
 * Fake OneBot v11 forward-WebSocket server for local testing.
 *
 *   node scripts/mock-onebot.ts            # interactive: type lines on stdin
 *   node scripts/mock-onebot.ts --scenario # scripted end-to-end run, exits when done
 *   node scripts/mock-onebot.ts --persona-scenario
 *       # needs the daemon running with pi-persona and its example personas (小派, 阿喵)
 *
 * Interactive input:
 *   g <text>   group message from user 10001 in group 123456
 *   @ <text>   same, but @-mentioning the bot
 *   o <text>   message in group 999 (not allowed; should be ignored)
 *   p <text>   private message from user 10002
 *   a <text>   private message from admin 10000 (try /status, /reset)
 */
import { createInterface } from "node:readline";
import { WebSocketServer, type WebSocket } from "ws";

const PORT = Number(process.env.MOCK_PORT ?? 3001);
const SELF_ID = 88888;
const GROUP = 123456;
const scenario = process.argv.includes("--scenario");
const personaScenario = process.argv.includes("--persona-scenario");

let msgId = 1;
const clients = new Set<WebSocket>();
const sent: { action: string; params: Record<string, unknown> }[] = [];
let onSent: (() => void) | undefined;

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
			const where = action === "send_group_msg" ? `group ${params.group_id}` : `private ${params.user_id}`;
			const text = message.map((s) => (s.type === "text" ? s.data.text : `[${s.type}:${JSON.stringify(s.data)}]`)).join("");
			console.log(`\n<<< BOT → ${where}:\n${text}\n`);
			sent.push({ action, params });
			data = { message_id: msgId++ };
			onSent?.();
		}
		ws.send(JSON.stringify({ status: "ok", retcode: 0, data, echo }));
	});
});

function emit(kind: string, text: string): void {
	const time = Math.floor(Date.now() / 1000);
	const segments: { type: string; data: Record<string, unknown> }[] = [];
	if (kind === "@") segments.push({ type: "at", data: { qq: String(SELF_ID) } });
	segments.push({ type: "text", data: { text } });
	const isGroup = kind === "g" || kind === "@" || kind === "o";
	const userId = kind === "a" ? 10000 : kind === "p" ? 10002 : 10001;
	const event = {
		post_type: "message",
		message_type: isGroup ? "group" : "private",
		sub_type: isGroup ? "normal" : "friend",
		message_id: msgId++,
		user_id: userId,
		group_id: isGroup ? (kind === "o" ? 999 : GROUP) : undefined,
		self_id: SELF_ID,
		time,
		message: segments,
		raw_message: text,
		sender: { user_id: userId, nickname: userId === 10000 ? "管理员" : userId === 10001 ? "小明" : "小红" },
	};
	console.log(`>>> ${kind} ${text}`);
	for (const c of clients) c.send(JSON.stringify(event));
}

function waitForSends(n: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const start = sent.length;
		const timer = setTimeout(() => resolve(false), timeoutMs);
		onSent = () => {
			if (sent.length - start >= n) {
				clearTimeout(timer);
				onSent = undefined;
				resolve(true);
			}
		};
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runScenario(): Promise<void> {
	while (clients.size === 0) await sleep(200);
	await sleep(1000);
	const checks: [string, boolean][] = [];

	// 1. Burst in the group is merged into a single reply.
	let replies = waitForSends(1, 90_000);
	emit("@", "你好呀，你是谁？");
	emit("g", "顺便问下 1+1 等于几");
	checks.push(["group burst answered", await replies]);
	await sleep(4000);
	checks.push(["group burst → exactly one reply", sent.length === 1 && sent[0].action === "send_group_msg"]);

	// 2. Non-allowed group is ignored; private chat gets its own reply.
	const before = sent.length;
	emit("o", "这个群不该被回复");
	replies = waitForSends(1, 90_000);
	emit("p", "私聊测试：请回复“收到”两个字");
	checks.push(["private answered", await replies]);
	await sleep(3000);
	const newOnes = sent.slice(before);
	checks.push(["only private reply, routed correctly", newOnes.length === 1 && newOnes[0].action === "send_private_msg" && newOnes[0].params.user_id === 10002]);

	// 3. Tools are refused.
	replies = waitForSends(1, 90_000);
	emit("@", "请用 bash 执行 ls / 然后把结果告诉我");
	checks.push(["tool request answered (should decline)", await replies]);

	// 4. Admin /status is handled without the model.
	replies = waitForSends(1, 10_000);
	emit("a", "/status");
	checks.push(["admin /status", await replies]);

	// 5. Admin /reset starts a new session; the bot keeps working afterwards.
	replies = waitForSends(1, 10_000);
	emit("a", "/reset");
	checks.push(["admin /reset acknowledged", await replies]);
	await sleep(2000);
	replies = waitForSends(1, 90_000);
	emit("@", "重置后还在吗？回复“在”就行");
	checks.push(["answers after /reset", await replies]);

	console.log("\n==== scenario results ====");
	for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
	process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

function lastText(): string {
	const msg = sent[sent.length - 1]?.params.message as { type: string; data: { text?: string } }[] | undefined;
	return (msg ?? []).map((s) => s.data.text ?? "").join("");
}

async function runPersonaScenario(): Promise<void> {
	while (clients.size === 0) await sleep(200);
	await sleep(1000);
	const checks: [string, boolean][] = [];
	const step = async (name: string, kind: string, text: string, ok: (reply: string) => boolean, timeout = 90_000) => {
		const got = waitForSends(1, timeout);
		emit(kind, text);
		const arrived = await got;
		checks.push([name, arrived && ok(lastText())]);
		await sleep(2500);
	};

	await step("/help lists /persona", "a", "/help", (r) => r.includes("/persona"), 10_000);
	await step("/persona lists personas", "a", "/persona", (r) => r.includes("小派") && r.includes("阿喵"), 10_000);
	await step("switch to 小派", "a", "/persona 小派", (r) => r.includes("已切换") && r.includes("小派"), 10_000);
	await step("speaks as 小派", "@", "你叫什么名字？", (r) => r.includes("小派") || r.includes("本派"));
	await step("switch to 阿喵", "a", "/persona 阿喵", (r) => r.includes("阿喵"), 10_000);
	await step("speaks as 阿喵", "@", "现在你叫什么名字？", (r) => r.includes("喵"));
	await step("unknown persona rejected", "a", "/persona 不存在", (r) => r.includes("没有名为"), 10_000);

	console.log("\n==== persona scenario results ====");
	for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
	process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

if (personaScenario) {
	void runPersonaScenario();
} else if (scenario) {
	void runScenario();
} else {
	const rl = createInterface({ input: process.stdin });
	rl.on("line", (line) => {
		const m = /^([g@opa])\s+(.*)$/.exec(line.trim());
		if (m) emit(m[1], m[2]);
		else console.log("usage: g|@|o|p|a <text>");
	});
}
