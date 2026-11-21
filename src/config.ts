import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface QQBotConfig {
	onebot: {
		/** Forward WebSocket URL of NapCat / LLOneBot, e.g. ws://127.0.0.1:3001 */
		url: string;
		/** OneBot access token (sent as `Authorization: Bearer <token>`) */
		accessToken?: string;
	};
	/** Group IDs the bot listens to. Empty = no groups. */
	allowedGroups: number[];
	/** Whether to answer private (friend / temp) messages. */
	allowPrivate: boolean;
	/** If non-empty, only these QQ IDs may talk to the bot in private chat. */
	privateWhitelist: number[];
	/** QQ IDs allowed to use /reset and /status. */
	admins: number[];
	/** Bot display name used in the persona prompt. */
	botName: string;
	/** Extra persona / behaviour text added to the system prompt. */
	persona: string;
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
	onebot: { url: "ws://127.0.0.1:3001" },
	allowedGroups: [],
	allowPrivate: true,
	privateWhitelist: [],
	admins: [],
	botName: "Pi",
	persona: "",
	debounceMs: 1500,
	maxReplyChars: 1500,
	quoteReply: false,
	images: true,
	maxImageBytes: 5 * 1024 * 1024,
	sessionDir: join(dataHome, "pi-qq", "sessions"),
	workspaceDir: join(dataHome, "pi-qq", "workspace"),
};

function numList(value: string | undefined): number[] | undefined {
	if (value === undefined) return undefined;
	return value
		.split(/[,\s]+/)
		.filter(Boolean)
		.map(Number)
		.filter((n) => Number.isFinite(n));
}

/**
 * Load config from $PI_QQ_CONFIG (or ~/.config/pi-qq/config.json), then apply
 * environment overrides: PI_QQ_WS_URL, PI_QQ_ACCESS_TOKEN, PI_QQ_GROUPS, PI_QQ_ADMINS.
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
		onebot: { ...DEFAULT_CONFIG.onebot, ...fileConfig.onebot },
	};
	const env = process.env;
	if (env.PI_QQ_WS_URL) config.onebot.url = env.PI_QQ_WS_URL;
	if (env.PI_QQ_ACCESS_TOKEN) config.onebot.accessToken = env.PI_QQ_ACCESS_TOKEN;
	config.allowedGroups = numList(env.PI_QQ_GROUPS) ?? config.allowedGroups;
	config.admins = numList(env.PI_QQ_ADMINS) ?? config.admins;
	return config;
}
