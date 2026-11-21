/**
 * Resolve a hostname's real addresses over DNS-over-HTTPS and reject internal ones.
 *
 * Why: on machines with a TUN/fake-IP proxy (mihomo/Clash), every hostname
 * resolves locally to a fake 198.18.x.x address, so pi-web-access's own SSRF
 * check cannot see that a hostname really points at 127.0.0.1, a LAN host or a
 * cloud metadata endpoint. DoH queries go to fixed resolver IPs, bypassing the
 * fake-IP DNS, and return the real records.
 *
 * Limits: the proxy resolves the name again when it connects, so a hostile DNS
 * server that answers differently each time (DNS rebinding) can still slip
 * through. This raises the bar; a proxy-side ACL closes the gap completely.
 */
import { isIP } from "node:net";

export const DEFAULT_DOH_RESOLVERS = ["https://223.5.5.5/resolve", "https://1.1.1.1/dns-query"];

function ipv4ToInt(ip: string): number {
	return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15], // benchmarking range; also where fake-IP proxies live
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

/** True for loopback, private, link-local, CGNAT, multicast, reserved and fake-IP addresses. */
export function isInternalAddress(ip: string): boolean {
	const kind = isIP(ip);
	if (kind === 4) {
		const n = ipv4ToInt(ip);
		return V4_BLOCKED.some(([base, bits]) => {
			const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
			return (n & mask) === (ipv4ToInt(base) & mask);
		});
	}
	if (kind === 6) {
		const v6 = ip.toLowerCase();
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
		if (mapped) return isInternalAddress(mapped[1]);
		if (v6 === "::" || v6 === "::1") return true;
		const first = Number.parseInt(v6.split(":")[0] || "0", 16);
		if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
		if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
		if ((first & 0xff00) === 0xff00) return true; // multicast
		if (v6.startsWith("64:ff9b:")) return true; // NAT64
		return false;
	}
	return true; // not an IP at all: treat as unsafe
}

export type Resolver = (host: string, type: "A" | "AAAA") => Promise<string[]>;

/** DoH JSON API resolver (AliDNS /resolve and Cloudflare /dns-query both speak it). */
export function dohResolver(endpoints: string[] = DEFAULT_DOH_RESOLVERS): Resolver {
	return async (host, type) => {
		let lastError: unknown;
		for (const endpoint of endpoints) {
			try {
				const url = new URL(endpoint);
				url.searchParams.set("name", host);
				url.searchParams.set("type", type);
				const res = await fetch(url, {
					headers: { accept: "application/dns-json" },
					signal: AbortSignal.timeout(5000),
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const body = (await res.json()) as { Status?: number; Answer?: { type: number; data: string }[] };
				if (body.Status !== 0 && body.Status !== 3) throw new Error(`DNS status ${body.Status}`);
				const want = type === "A" ? 1 : 28;
				return (body.Answer ?? []).filter((a) => a.type === want).map((a) => a.data.trim());
			} catch (err) {
				lastError = err;
			}
		}
		throw new Error(`DoH lookup failed for ${host}: ${(lastError as Error)?.message ?? lastError}`);
	};
}

export interface HostCheck {
	ok: boolean;
	reason?: string;
	addresses: string[];
}

const cache = new Map<string, { at: number; result: HostCheck }>();

/** Check that `host` (or an IP literal) only resolves to public addresses. */
export async function checkHost(host: string, resolve: Resolver): Promise<HostCheck> {
	const h = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (isIP(h)) {
		return isInternalAddress(h) ? { ok: false, reason: `${h} is an internal address`, addresses: [h] } : { ok: true, addresses: [h] };
	}
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".internal")) {
		return { ok: false, reason: `${h} is a local name`, addresses: [] };
	}
	const hit = cache.get(h);
	if (hit && Date.now() - hit.at < 60_000) return hit.result;

	let result: HostCheck;
	try {
		const [v4, v6] = await Promise.all([resolve(h, "A"), resolve(h, "AAAA").catch(() => [] as string[])]);
		const addresses = [...v4, ...v6];
		const bad = addresses.filter(isInternalAddress);
		if (addresses.length === 0) result = { ok: false, reason: `${h} has no public address`, addresses };
		else if (bad.length > 0) result = { ok: false, reason: `${h} resolves to internal address ${bad.join(", ")}`, addresses };
		else result = { ok: true, addresses };
	} catch (err) {
		// Fail closed: without the real address we cannot tell where the proxy would connect.
		result = { ok: false, reason: (err as Error).message, addresses: [] };
	}
	cache.set(h, { at: Date.now(), result });
	if (cache.size > 500) cache.delete(cache.keys().next().value as string);
	return result;
}
