/**
 * Headless launcher: runs a persistent Pi session with only the QQ extension
 * loaded and no tools, then stays alive until SIGINT/SIGTERM.
 *
 *   node src/daemon.ts
 */
import { mkdirSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import qqChatExtension, { stopQQBot } from "./extension.ts";

const log = (msg: string) => console.error(`${new Date().toISOString()} pi-qq ${msg}`);

const config = loadConfig();
if (config.allowedGroups.length === 0 && !config.allowPrivate) {
	log("warning: no allowedGroups and allowPrivate=false — the bot will ignore every message");
}
mkdirSync(config.workspaceDir, { recursive: true });
mkdirSync(config.sessionDir, { recursive: true });

const agentDir = getAgentDir();

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		resourceLoaderOptions: {
			// Only our extension: nothing from ~/.pi/agent/extensions, no skills, prompts or AGENTS.md.
			noExtensions: true,
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
