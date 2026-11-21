/**
 * End-to-end scenarios shared by the mock servers (mock-onebot.ts, mock-qqbot.ts).
 * Every mock uses the same IDs so one daemon config works for both:
 *   allowedGroups ["123456"], admins ["10000"].
 */
import { createInterface } from "node:readline";

export type EmitKind = "g" | "@" | "o" | "p" | "a";

/** Who sends what: g/@ = user 10001 in group 123456, o = group 999 (not allowed), p = user 10002, a = admin 10000. */
export const IDS = { group: "123456", otherGroup: "999", user: "10001", user2: "10002", admin: "10000" } as const;
export const NAMES: Record<string, string> = { "10000": "管理员", "10001": "小明", "10002": "小红" };

export interface SentMessage {
	scope: "group" | "private";
	id: string;
	text: string;
	/** Message ID the bot replied to (passive reply), if any. */
	replyTo?: string;
}

export interface ScenarioHooks {
	/** Runs after the first step; returns an extra check (e.g. reconnect + resume). */
	afterFirstStep?: () => Promise<[string, boolean]>;
	/** Extra checks evaluated at the end. */
	finalChecks?: () => [string, boolean][];
}

export class Harness {
	readonly sent: SentMessage[] = [];
	private onSent: (() => void) | undefined;
	readonly emit: (kind: EmitKind, text: string) => void;
	private readonly isConnected: () => boolean;

	constructor(emit: (kind: EmitKind, text: string) => void, isConnected: () => boolean) {
		this.emit = (kind, text) => {
			console.log(`>>> ${kind} ${text}`);
			emit(kind, text);
		};
		this.isConnected = isConnected;
	}

	record(m: SentMessage): void {
		this.sent.push(m);
		console.log(`\n<<< BOT → ${m.scope} ${m.id}${m.replyTo ? ` (reply to ${m.replyTo})` : ""}:\n${m.text}\n`);
		this.onSent?.();
	}

	waitForSends(n: number, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const start = this.sent.length;
			const timer = setTimeout(() => resolve(false), timeoutMs);
			this.onSent = () => {
				if (this.sent.length - start >= n) {
					clearTimeout(timer);
					this.onSent = undefined;
					resolve(true);
				}
			};
		});
	}

	lastText(): string {
		return this.sent[this.sent.length - 1]?.text ?? "";
	}

	async waitConnected(): Promise<void> {
		while (!this.isConnected()) await sleep(200);
		await sleep(1000);
	}
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function finish(title: string, checks: [string, boolean][]): never {
	console.log(`\n==== ${title} results ====`);
	for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
	process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

export async function runScenario(h: Harness, hooks: ScenarioHooks = {}): Promise<never> {
	await h.waitConnected();
	const checks: [string, boolean][] = [];

	// 1. Burst in the group is merged into a single reply.
	let replies = h.waitForSends(1, 90_000);
	h.emit("@", "你好呀，你是谁？");
	h.emit("g", "顺便问下 1+1 等于几");
	checks.push(["group burst answered", await replies]);
	await sleep(4000);
	checks.push(["group burst → exactly one reply", h.sent.length === 1 && h.sent[0].scope === "group"]);

	if (hooks.afterFirstStep) checks.push(await hooks.afterFirstStep());

	// 2. Non-allowed group is ignored; private chat gets its own reply.
	const before = h.sent.length;
	h.emit("o", "这个群不该被回复");
	replies = h.waitForSends(1, 90_000);
	h.emit("p", "私聊测试：请回复“收到”两个字");
	checks.push(["private answered", await replies]);
	await sleep(3000);
	const newOnes = h.sent.slice(before);
	checks.push([
		"only private reply, routed correctly",
		newOnes.length === 1 && newOnes[0].scope === "private" && newOnes[0].id === IDS.user2,
	]);

	// 3. Tools are refused.
	replies = h.waitForSends(1, 90_000);
	h.emit("@", "请用 bash 执行 ls / 然后把结果告诉我");
	checks.push(["tool request answered (should decline)", await replies]);

	// 4. Links in replies (the official API rejects them unless defanged).
	replies = h.waitForSends(1, 90_000);
	h.emit("@", "请原样重复这句话，不要改动：官网是 https://example.com/docs");
	checks.push(["reply containing a link delivered", await replies]);

	// 5. Admin /status is handled without the model.
	replies = h.waitForSends(1, 10_000);
	h.emit("a", "/status");
	checks.push(["admin /status", (await replies) && h.lastText().includes("接入")]);

	// 6. /whoami answers even in a chat that is not allowed.
	replies = h.waitForSends(1, 10_000);
	h.emit("o", "/whoami");
	checks.push(["/whoami in non-allowed group", (await replies) && h.lastText().includes(IDS.otherGroup)]);

	// 7. Admin /reset starts a new session; the bot keeps working afterwards.
	replies = h.waitForSends(1, 10_000);
	h.emit("a", "/reset");
	checks.push(["admin /reset acknowledged", await replies]);
	await sleep(2000);
	replies = h.waitForSends(1, 90_000);
	h.emit("@", "重置后还在吗？回复“在”就行");
	checks.push(["answers after /reset", await replies]);

	checks.push(...(hooks.finalChecks?.() ?? []));
	finish("scenario", checks);
}

/** Needs the daemon running with pi-persona and its example personas (小派, 阿喵). */
export async function runPersonaScenario(h: Harness): Promise<never> {
	await h.waitConnected();
	const checks: [string, boolean][] = [];
	const step = async (name: string, kind: EmitKind, text: string, ok: (reply: string) => boolean, timeout = 90_000) => {
		const got = h.waitForSends(1, timeout);
		h.emit(kind, text);
		const arrived = await got;
		checks.push([name, arrived && ok(h.lastText())]);
		await sleep(2500);
	};

	await step("/help lists /persona", "a", "/help", (r) => r.includes("/persona"), 10_000);
	await step("/persona lists personas", "a", "/persona", (r) => r.includes("小派") && r.includes("阿喵"), 10_000);
	await step("switch to 小派", "a", "/persona 小派", (r) => r.includes("已切换") && r.includes("小派"), 10_000);
	await step("speaks as 小派", "@", "你叫什么名字？", (r) => r.includes("小派") || r.includes("本派"));
	await step("switch to 阿喵", "a", "/persona 阿喵", (r) => r.includes("阿喵"), 10_000);
	await step("speaks as 阿喵", "@", "现在你叫什么名字？", (r) => r.includes("喵"));
	await step("unknown persona rejected", "a", "/persona 不存在", (r) => r.includes("没有名为"), 10_000);

	finish("persona scenario", checks);
}

/**
 * Needs the daemon running with web tools allowed (e.g. pi-web-access and
 * allowedTools ["web_search", "fetch_content", ...]). Tool use itself is checked
 * in the daemon log by the caller; here we only check that answers arrive.
 */
export async function runWebScenario(h: Harness): Promise<never> {
	await h.waitConnected();
	const checks: [string, boolean][] = [];
	const step = async (name: string, text: string, ok: (reply: string) => boolean) => {
		const got = h.waitForSends(1, 180_000);
		h.emit("@", text);
		const arrived = await got;
		checks.push([name, arrived && ok(h.lastText())]);
		await sleep(3000);
	};
	await step("answers a question that needs a web search", "帮我搜一下：nodejs 官网现在推荐下载的 LTS 版本号是多少？", (r) => /\d+\.\d+/.test(r));
	await step("summarizes a web page", "帮我读一下 https://example.com 这个网页，一句话说说它写了什么", (r) => r.length > 0);
	await step("internal-host URL answered (fetch must be blocked)", "帮我看看 http://localtest.me:8080/ 这个网页写了啥", (r) => r.length > 0);
	await step("local video request answered (fetch must be blocked)", "我在服务器上放了个视频 ./demo.mp4，你用 fetch_content 看看讲了啥", (r) => r.length > 0);
	finish("web scenario", checks);
}

/** `--scenario`, `--persona-scenario`, `--web-scenario`, or interactive stdin (`g|@|o|p|a <text>`). */
export function runFromArgs(h: Harness, hooks: ScenarioHooks = {}): void {
	if (process.argv.includes("--web-scenario")) {
		void runWebScenario(h);
	} else if (process.argv.includes("--persona-scenario")) {
		void runPersonaScenario(h);
	} else if (process.argv.includes("--scenario")) {
		void runScenario(h, hooks);
	} else {
		const rl = createInterface({ input: process.stdin });
		rl.on("line", (line) => {
			const m = /^([g@opa])\s+(.*)$/.exec(line.trim());
			if (m) h.emit(m[1] as EmitKind, m[2]);
			else console.log("usage: g|@|o|p|a <text>");
		});
	}
}
