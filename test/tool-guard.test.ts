import assert from "node:assert/strict";
import { test } from "node:test";
import { checkHost, isInternalAddress, type Resolver } from "../src/real-ip.ts";
import { guardToolInput } from "../src/tool-guard.ts";

const fakeDns: Record<string, string[]> = {
	"example.com": ["93.184.215.14"],
	"localtest.me": ["127.0.0.1"],
	"lan.example.org": ["192.168.1.10"],
	"meta.example.org": ["169.254.169.254"],
	"mixed.example.org": ["8.8.8.8", "10.0.0.5"],
	"v6.example.org": ["2606:4700::1111"],
	"v6local.example.org": ["fd00::1"],
};
const resolve: Resolver = async (host, type) => {
	if (host === "dns-down.example.org") throw new Error("timeout");
	const all = fakeDns[host] ?? [];
	return all.filter((ip) => (type === "A" ? !ip.includes(":") : ip.includes(":")));
};

test("internal address classification", () => {
	for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.1", "169.254.169.254", "100.64.1.1", "198.18.1.109", "0.0.0.0", "::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1"]) {
		assert.equal(isInternalAddress(ip), true, ip);
	}
	for (const ip of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
		assert.equal(isInternalAddress(ip), false, ip);
	}
});

test("checkHost: public ok, internal / mixed / local names / DNS failure blocked", async () => {
	assert.equal((await checkHost("example.com", resolve)).ok, true);
	assert.equal((await checkHost("v6.example.org", resolve)).ok, true);
	for (const h of ["localtest.me", "lan.example.org", "meta.example.org", "mixed.example.org", "v6local.example.org", "dns-down.example.org", "nothing.example.org", "localhost", "printer.lan", "127.0.0.1", "[::1]"]) {
		assert.equal((await checkHost(h, resolve)).ok, false, h);
	}
});

test("http(s) URLs to public hosts pass; fetch_content gets same-origin redirects", async () => {
	const input: Record<string, unknown> = { url: "https://example.com/a" };
	assert.deepEqual(await guardToolInput("fetch_content", input, { resolve }), { stripped: [] });
	assert.equal(input.redirects, "same-origin");
	const other: Record<string, unknown> = { query: "北京天气" };
	assert.deepEqual(await guardToolInput("web_search", other, { resolve }), { stripped: [] });
	assert.equal(other.redirects, undefined);
});

test("local paths, other schemes and internal hosts are blocked", async () => {
	for (const url of ["/etc/passwd", "./video.mp4", "file:///home/u/a.mp4", "~/a.mp4", "ftp://x", "javascript:alert(1)", "", "http://localtest.me/", "https://meta.example.org/latest/meta-data", "http://192.168.1.1/"]) {
		assert.ok((await guardToolInput("fetch_content", { url }, { resolve })).block, url);
	}
	assert.ok((await guardToolInput("fetch_content", { urls: ["https://example.com", "http://lan.example.org"] }, { resolve })).block);
	assert.ok((await guardToolInput("fetch_content", { url: 42 }, { resolve })).block);
});

test("auth and proxy are stripped", async () => {
	const input: Record<string, unknown> = { url: "https://example.com", auth: true, proxy: "socks5h://evil:1080" };
	assert.deepEqual(await guardToolInput("fetch_content", input, { resolve }), { stripped: ["auth", "proxy"] });
	assert.deepEqual(input, { url: "https://example.com", redirects: "same-origin" });
});
