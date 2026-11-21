/**
 * Safety net for the tools a QQ bot may use (config `allowedTools`, e.g. the web
 * tools from pi-web-access). Anyone in the group can steer the model, so tool
 * inputs are checked before they run:
 *   - URL fields must be http(s); local paths and file:// are refused
 *     (pi-web-access's fetch_content would otherwise read local video files)
 *   - every URL host must resolve (over DoH) to public addresses only; this
 *     matters behind TUN/fake-IP proxies, see real-ip.ts
 *   - `auth` (browser-cookie profiles) and `proxy` are removed
 *   - fetch_content only follows same-origin redirects, so an allowed page
 *     cannot bounce the fetch to an internal host
 */
import { checkHost, type Resolver } from "./real-ip.ts";

const URL_FIELDS = ["url", "urls"];
const STRIPPED_FIELDS = ["auth", "proxy"];

export interface GuardResult {
	/** Set when the call must not run. */
	block?: string;
	/** Fields removed from the input (mutated in place). */
	stripped: string[];
}

export interface GuardOptions {
	/** Resolver for the real-IP check; omit to skip it (tests, trusted networks). */
	resolve?: Resolver;
}

function parseHttpUrl(value: unknown): URL | undefined {
	if (typeof value !== "string" || !/^https?:\/\/[^/\s]/i.test(value.trim())) return undefined;
	try {
		return new URL(value.trim());
	} catch {
		return undefined;
	}
}

/** Check and sanitize a tool call's input in place. */
export async function guardToolInput(
	toolName: string,
	input: Record<string, unknown>,
	options: GuardOptions = {},
): Promise<GuardResult> {
	const stripped: string[] = [];
	for (const key of STRIPPED_FIELDS) {
		if (key in input) {
			delete input[key];
			stripped.push(key);
		}
	}
	const urls: URL[] = [];
	for (const key of URL_FIELDS) {
		const value = input[key];
		if (value === undefined) continue;
		for (const item of Array.isArray(value) ? value : [value]) {
			const url = parseHttpUrl(item);
			if (!url) return { block: `only http(s) URLs are allowed here, not ${JSON.stringify(item).slice(0, 80)}`, stripped };
			urls.push(url);
		}
	}
	if (options.resolve) {
		for (const host of new Set(urls.map((u) => u.hostname))) {
			const check = await checkHost(host, options.resolve);
			if (!check.ok) return { block: `refusing to fetch ${host}: ${check.reason}`, stripped };
		}
	}
	if (toolName === "fetch_content") input.redirects = "same-origin";
	return { stripped };
}
