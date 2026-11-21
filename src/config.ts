import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type AdapterName = "onebot" | "qqbot";

export interface QQBotConfig {
	/** "onebot" (NapCat / LLOneBot) or "qqbot" (official QQ bot, WebSocket). */
	adapter: AdapterName;
	/** Official QQ bot (q.qq.com) credentials; used when adapter = "qqbot". */
	qqbot: {
		appId: string;
		appSecret: string;
		/** API base URL; change only for testing. */
		apiBase: string;
		/** Gateway intents; default GROUP_AND_C2C_EVENT (1 << 25). */
		intents: number;
	};
	onebot: {
		/** Forward WebSocket URL of NapCat / LLOneBot, e.g. ws://127.0.0.1:3001 */
		url: string;
		/** OneBot access token (sent as `Authorization: Bearer <token>`) */
		accessToken?: string;
	};
	/** Group IDs the bot listens to (QQ group numbers, or group_openid for qqbot). */
	allowedGroups: string[];
	/** Whether to answer private messages. */
	allowPrivate: boolean;
	/** If non-empty, only these user IDs may talk to the bot in private chat. */
	privateWhitelist: string[];
	/** User IDs allowed to use /status, /reset and other Pi extension commands. */
	admins: string[];
	/**
	 * Tools the model may use, e.g. ["web_search", "fetch_content", "get_search_content",
	 * "source_check"] from pi-web-access. Empty (default) = pure chat. bash/read/edit/write
	 * should never be listed: everyone in the group can steer the model.
	 */
	allowedTools: string[];
	/** Upper bound on tool calls while answering one batch of messages. */
	maxToolCallsPerReply: number;
	/** Pi extension commands admins may run from QQ (without "/"); "*" = all. */
	forwardCommands: string[];
	/**
	 * Before a tool fetches a URL, resolve its host over DNS-over-HTTPS and refuse
	 * internal addresses (needed behind TUN/fake-IP proxies). Default true.
	 */
	realIpCheck: boolean;
	/** DoH JSON endpoints for realIpCheck, tried in order. */
	dohResolvers: string[];
	/** Bot name for the default preamble (used when no persona extension sets one). */
	botName: string;
	/**
	 * Extra Pi extensions the daemon loads, e.g. "git:github.com/keqiant/pi-persona"
	 * or a local path (relative paths resolve against the config file's directory).
	 */
	extensions: string[];
	/** Wait this long after the last message of a burst before answering. */
	debounceMs: number;
	/** Split replies longer than this into several QQ messages. */
	maxReplyChars: number;
	/** Quote (reply to) the last message of the batch in group chats. */
	quoteReply: boolean;
	/** Forward images to the model (requires an image-capable model). */
	images: boolean;
	/** Max image bytes to download per image. */
	maxImageBytes: number;
	/** Model as "provider/modelId"; default = Pi's configured default. */
	model?: string;
	/** Thinking level: off | minimal | low | medium | high | xhigh | max */
	thinkingLevel?: string;
	/** Where the daemon keeps Pi session files. */
	sessionDir: string;
	/** Empty working directory for the daemon's Pi session. */
	workspaceDir: string;
}

const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");

export const DEFAULT_CONFIG_PATH = join(configHome, "pi-qq", "config.json");

export const DEFAULT_CONFIG: QQBotConfig = {
	adapter: "onebot",
	qqbot: { appId: "", appSecret: "", apiBase: "https://api.bot.qq.com", intents: 1 << 25 },
	onebot: { url: "ws://127.0.0.1:3001" },
	allowedGroups: [],
	allowPrivate: true,
	privateWhitelist: [],
	admins: [],
	botName: "Pi",
	extensions: [],
	allowedTools: [],
	maxToolCallsPerReply: 6,
	forwardCommands: ["persona"],
	realIpCheck: true,
	dohResolvers: ["https://223.5.5.5/resolve", "https://1.1.1.1/dns-query"],
	debounceMs: 1500,
	maxReplyChars: 1500,
	quoteReply: false,
	images: true,
	maxImageBytes: 5 * 1024 * 1024,
	sessionDir: join(dataHome, "pi-qq", "sessions"),
	workspaceDir: join(dataHome, "pi-qq", "workspace"),
};

function envList(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	return value.split(/[,\s]+/).filter(Boolean);
}

/** IDs may be written as numbers (QQ numbers) or strings (openids). */
function idList(value: unknown): string[] {
	return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : [];
}

function isLocalPath(source: string): boolean {
	return !/^(npm|git|builtin):/.test(source) && !/^https?:\/\//.test(source);
}

/**
 * Load config from $PI_QQ_CONFIG (or ~/.config/pi-qq/config.json), then apply
 * environment overrides: PI_QQ_ADAPTER, PI_QQ_WS_URL, PI_QQ_ACCESS_TOKEN,
 * PI_QQ_APP_ID, PI_QQ_APP_SECRET, PI_QQ_API_BASE, PI_QQ_GROUPS, PI_QQ_ADMINS,
 * PI_QQ_EXTENSIONS (comma-separated).
 */
export function loadConfig(path = process.env.PI_QQ_CONFIG ?? DEFAULT_CONFIG_PATH): QQBotConfig {
	let fileConfig: Partial<QQBotConfig> = {};
	if (existsSync(path)) {
		try {
			fileConfig = JSON.parse(readFileSync(path, "utf8")) as Partial<QQBotConfig>;
		} catch (err) {
			throw new Error(`pi-qq: cannot parse config ${path}: ${(err as Error).message}`);
		}
	}
	const config: QQBotConfig = {
		...DEFAULT_CONFIG,
		...fileConfig,
		qqbot: { ...DEFAULT_CONFIG.qqbot, ...fileConfig.qqbot },
		onebot: { ...DEFAULT_CONFIG.onebot, ...fileConfig.onebot },
	};
	config.allowedGroups = idList(config.allowedGroups);
	config.privateWhitelist = idList(config.privateWhitelist);
	config.admins = idList(config.admins);
	config.allowedTools = idList(config.allowedTools);
	config.forwardCommands = idList(config.forwardCommands).map((c) => c.replace(/^\//, ""));
	config.qqbot.appId = String(config.qqbot.appId ?? "");
	const env = process.env;
	if (env.PI_QQ_ADAPTER === "onebot" || env.PI_QQ_ADAPTER === "qqbot") config.adapter = env.PI_QQ_ADAPTER;
	if (env.PI_QQ_WS_URL) config.onebot.url = env.PI_QQ_WS_URL;
	if (env.PI_QQ_ACCESS_TOKEN) config.onebot.accessToken = env.PI_QQ_ACCESS_TOKEN;
	if (env.PI_QQ_APP_ID) config.qqbot.appId = env.PI_QQ_APP_ID;
	if (env.PI_QQ_APP_SECRET) config.qqbot.appSecret = env.PI_QQ_APP_SECRET;
	if (env.PI_QQ_API_BASE) config.qqbot.apiBase = env.PI_QQ_API_BASE;
	config.qqbot.apiBase = config.qqbot.apiBase.replace(/\/+$/, "");
	config.allowedGroups = envList(env.PI_QQ_GROUPS) ?? config.allowedGroups;
	config.admins = envList(env.PI_QQ_ADMINS) ?? config.admins;
	if (env.PI_QQ_EXTENSIONS !== undefined) config.extensions = env.PI_QQ_EXTENSIONS.split(",").filter(Boolean);
	const base = existsSync(path) ? dirname(path) : process.cwd();
	config.extensions = config.extensions.map((e) => (isLocalPath(e) && !isAbsolute(e) ? resolve(base, e) : e));
	if ("persona" in fileConfig) {
		console.error("pi-qq: config field \"persona\" is no longer used; install the pi-persona extension instead");
	}
	return config;
}
