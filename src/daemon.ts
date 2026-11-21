/**
 * Headless launcher: runs a persistent Pi session with the QQ extension plus
 * the extensions listed in config.extensions (e.g. pi-persona), with no tools,
 * then stays alive until SIGINT/SIGTERM.
 *
 *   node src/daemon.ts
 *
 * The Pi SDK is loaded from the installed Pi (see pi-sdk.ts): no `npm install`
 * needed, and the bot always runs the same Pi version as the `pi` command.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession, CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import qqChatExtension, { createQQUIContext, QQ_FLAG, stopQQBot } from "./extension.ts";
import { loadPiSdk } from "./pi-sdk.ts";

const log = (msg: string) => console.error(`${new Date().toISOString()} pi-qq ${msg}`);

let pi: Awaited<ReturnType<typeof loadPiSdk>>;
try {
	pi = await loadPiSdk();
} catch (err) {
	log((err as Error).message);
	process.exit(1);
}
log(`pi sdk ${pi.version} from ${pi.dir}`);
const {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
} = pi.sdk;

const config = loadConfig();
if (config.adapter === "qqbot" && (!config.qqbot.appId || !config.qqbot.appSecret)) {
	log("error: adapter \"qqbot\" needs qqbot.appId and qqbot.appSecret in the config (or PI_QQ_APP_ID / PI_QQ_APP_SECRET)");
	process.exit(1);
}
log(`adapter: ${config.adapter}`);
if (config.allowedGroups.length === 0 && !config.allowPrivate) {
	log("warning: no allowedGroups and allowPrivate=false — the bot will ignore every message");
}
mkdirSync(config.workspaceDir, { recursive: true });
// pi-persona: keep the bot's active persona separate from the one used in
// everyday Pi on the same machine (persona files stay shared). Override by
// setting PI_PERSONA_STATE yourself.
process.env.PI_PERSONA_STATE ??= join(dirname(config.sessionDir), "persona-active");
mkdirSync(config.sessionDir, { recursive: true });

const agentDir = getAgentDir();

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		// Turn the QQ extension on (same as `pi --qq`).
		extensionFlagValues: new Map([[QQ_FLAG, true]]),
		resourceLoaderOptions: {
			// Only our extension and the configured ones: nothing from ~/.pi/agent/extensions,
			// no skills, prompts or AGENTS.md.
			noExtensions: true,
			additionalExtensionPaths: config.extensions,
			disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
			extensionFactories: [qqChatExtension],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});

	let model;
	if (config.model) {
		const slash = config.model.indexOf("/");
		if (slash <= 0) throw new Error(`pi-qq: model must look like "provider/modelId", got "${config.model}"`);
		model = services.modelRuntime.getModel(config.model.slice(0, slash), config.model.slice(slash + 1));
		if (!model) throw new Error(`pi-qq: unknown model "${config.model}" (see \`pi --list-models\`)`);
	}

	return {
		...(await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model,
			thinkingLevel: config.thinkingLevel as ThinkingLevel | undefined,
			noTools: "all",
		})),
		services,
		diagnostics: services.diagnostics,
	};
};

const runtime = await createAgentSessionRuntime(createRuntime, {
	cwd: config.workspaceDir,
	agentDir,
	sessionManager: SessionManager.continueRecent(config.workspaceDir, config.sessionDir),
});

for (const d of runtime.diagnostics) log(`${d.type}: ${d.message}`);
if (runtime.modelFallbackMessage) log(runtime.modelFallbackMessage);

async function bind(session: AgentSession): Promise<void> {
	await session.bindExtensions({
		mode: "rpc",
		uiContext: createQQUIContext(),
		commandContextActions: {
			waitForIdle: () => runtime.session.waitForIdle(),
			newSession: (options) => runtime.newSession(options),
			fork: (entryId, options) => runtime.fork(entryId, options),
			navigateTree: async (targetId, options) => ({
				cancelled: (await runtime.session.navigateTree(targetId, options)).cancelled,
			}),
			switchSession: (path, options) => runtime.switchSession(path, options),
			reload: () => runtime.session.reload(),
		},
		shutdownHandler: () => void shutdown("extension request"),
		onError: (err) => log(`extension error: ${err.extensionPath ?? ""} ${err.event ?? ""} ${err.error}`),
	});
	const exts = runtime.services.resourceLoader.getExtensions();
	for (const e of exts.errors) log(`extension load error: ${e.path}: ${e.error}`);
	const m = session.model;
	log(`session ready: ${session.sessionFile ?? "(in-memory)"} model=${m ? `${m.provider}/${m.id}` : "none"}`);
}

runtime.setRebindSession(bind);
await bind(runtime.session);

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log(`shutting down (${reason})`);
	try {
		await runtime.dispose();
	} finally {
		stopQQBot();
		process.exit(0);
	}
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// Keep the event loop alive even while OneBot is disconnected.
setInterval(() => {}, 1 << 30);
