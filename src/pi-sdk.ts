/**
 * Locate and load the Pi SDK (@earendil-works/pi-coding-agent) from the Pi that
 * is already installed, so the daemon needs no `npm install` and always runs
 * the same Pi version as the `pi` command.
 *
 * Search order:
 *   1. $PI_SDK_PATH (the package directory)
 *   2. Pi's managed install: $PI_MANAGED_INSTALL_ROOT or ~/.pi/agent/install,
 *      releases/<current-version>/node_modules/@earendil-works/pi-coding-agent
 *   3. npm global install (`npm root -g`)
 *   4. this project's node_modules (development)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type PiSdk = typeof import("@earendil-works/pi-coding-agent");

const PKG_PATH = join("@earendil-works", "pi-coding-agent");

function managedCandidate(): string | undefined {
	const root = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi", "agent", "install");
	try {
		const version = readFileSync(join(root, "current-version"), "utf8").trim();
		if (version) return join(root, "releases", version, "node_modules", PKG_PATH);
	} catch {
		/* not a managed install */
	}
	return undefined;
}

function npmGlobalCandidate(): string | undefined {
	try {
		const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
		return root ? join(root, PKG_PATH) : undefined;
	} catch {
		return undefined;
	}
}

function localCandidate(): string | undefined {
	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const i = entry.lastIndexOf(PKG_PATH);
		return i >= 0 ? entry.slice(0, i + PKG_PATH.length) : undefined;
	} catch {
		return undefined;
	}
}

function entryOf(dir: string): { entry: string; version: string } | undefined {
	const pkgFile = join(dir, "package.json");
	if (!existsSync(pkgFile)) return undefined;
	const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as {
		version?: string;
		main?: string;
		exports?: { "."?: { import?: string } | string };
	};
	const exp = pkg.exports?.["."];
	const rel = (typeof exp === "string" ? exp : exp?.import) ?? pkg.main ?? "dist/index.js";
	const entry = join(dir, rel);
	return existsSync(entry) ? { entry, version: pkg.version ?? "?" } : undefined;
}

export async function loadPiSdk(): Promise<{ sdk: PiSdk; dir: string; version: string }> {
	const tried: string[] = [];
	const candidates = [
		() => process.env.PI_SDK_PATH,
		managedCandidate,
		npmGlobalCandidate,
		localCandidate,
	];
	for (const candidate of candidates) {
		const dir = candidate();
		if (!dir) continue;
		tried.push(dir);
		const found = entryOf(dir);
		if (!found) continue;
		const sdk = (await import(pathToFileURL(found.entry).href)) as PiSdk;
		return { sdk, dir, version: found.version };
	}
	throw new Error(
		`pi-qq: cannot find the Pi SDK (@earendil-works/pi-coding-agent). Install Pi first (see pi.dev), ` +
			`or set PI_SDK_PATH to the package directory.${tried.length ? `\nTried:\n  ${tried.join("\n  ")}` : ""}`,
	);
}
