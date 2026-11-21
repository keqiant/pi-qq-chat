import type { Segment } from "./onebot.ts";

/** Parse a CQ-code string message (`你好[CQ:at,qq=123]`) into segments. */
export function parseCQString(raw: string): Segment[] {
	const segments: Segment[] = [];
	const unescape = (s: string) =>
		s.replace(/&#91;/g, "[").replace(/&#93;/g, "]").replace(/&#44;/g, ",").replace(/&amp;/g, "&");
	const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;
	let last = 0;
	for (const m of raw.matchAll(re)) {
		if (m.index > last) segments.push({ type: "text", data: { text: unescape(raw.slice(last, m.index)) } });
		const data: Record<string, unknown> = {};
		for (const kv of m[2].split(",").filter(Boolean)) {
			const i = kv.indexOf("=");
			if (i > 0) data[kv.slice(0, i)] = unescape(kv.slice(i + 1));
		}
		segments.push({ type: m[1], data });
		last = m.index + m[0].length;
	}
	if (last < raw.length) segments.push({ type: "text", data: { text: unescape(raw.slice(last)) } });
	return segments;
}

export function getSegments(message: Segment[] | string): Segment[] {
	return typeof message === "string" ? parseCQString(message) : message;
}

export interface RenderedMessage {
	text: string;
	imageUrls: string[];
	mentionsSelf: boolean;
}

/** Turn message segments into plain text for the model. */
export function renderSegments(segments: Segment[], selfId: number | undefined): RenderedMessage {
	let text = "";
	const imageUrls: string[] = [];
	let mentionsSelf = false;
	for (const seg of segments) {
		const d = seg.data ?? {};
		switch (seg.type) {
			case "text":
				text += String(d.text ?? "");
				break;
			case "at": {
				const qq = String(d.qq ?? "");
				if (selfId !== undefined && qq === String(selfId)) {
					mentionsSelf = true;
					text += "@你 ";
				} else if (qq === "all") {
					text += "@全体成员 ";
				} else {
					text += `@${d.name ?? qq} `;
				}
				break;
			}
			case "face":
				text += "[表情]";
				break;
			case "mface":
			case "marketface":
				text += `[${d.summary ?? "表情包"}]`;
				break;
			case "image": {
				const url = typeof d.url === "string" ? d.url : typeof d.file === "string" && /^https?:/.test(d.file) ? d.file : undefined;
				if (url) imageUrls.push(url);
				text += d.summary && String(d.summary) !== "" ? `[图片${d.summary}]` : "[图片]";
				break;
			}
			case "reply":
				text += "[回复某条消息] ";
				break;
			case "record":
				text += "[语音]";
				break;
			case "video":
				text += "[视频]";
				break;
			case "file":
				text += `[文件 ${d.name ?? d.file ?? ""}]`;
				break;
			case "json":
			case "xml":
				text += "[卡片消息]";
				break;
			case "forward":
				text += "[合并转发]";
				break;
			default:
				text += `[${seg.type}]`;
		}
	}
	return { text: text.trim(), imageUrls, mentionsSelf };
}

function hhmm(unixSeconds: number): string {
	const d = new Date(unixSeconds * 1000);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** One line per incoming message, e.g. `[14:03] 小明(10001): 你好`. */
export function formatLine(time: number, name: string, displayId: string, body: string): string {
	return `[${hhmm(time)}] ${name}(${displayId}): ${body}`;
}

const TLDS = "com|cn|net|org|io|dev|app|me|co|top|xyz|info|gov|edu|tv|cc|ai|gg|so|site|tech|link|club|vip|shop|wiki|moe";
const SCHEME_URL = /\b(?:https?|ftp):\/\/[^\s<>"'，。！？）】]+/gi;
const WWW_OR_DOMAIN = new RegExp(`\\b(?:www\\.)?(?:[a-z0-9-]+\\.)+(?:${TLDS})\\b(?:/[^\\s<>"'，。！？）】]*)?`, "gi");

/**
 * The official QQ bot API rejects messages containing links (error 40054010).
 * Defang them ("example.com" → "example[.]com") so the reply still goes out.
 */
export function sanitizeUrls(text: string): string {
	const defang = (s: string) => s.replace(/\./g, "[.]");
	return text
		.replace(SCHEME_URL, (u) => defang(u.replace(/^[a-z]+:\/\//i, "")))
		.replace(WWW_OR_DOMAIN, defang);
}

/** QQ does not render Markdown; flatten common syntax into plain text. */
export function stripMarkdown(input: string): string {
	const lines = input.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let inFence = false;
	for (let line of lines) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}
		line = line
			.replace(/^\s{0,3}#{1,6}\s+/, "")
			.replace(/^\s*[-*_]{3,}\s*$/, "")
			.replace(/^(\s*)[-*+]\s+/, "$1· ")
			.replace(/^\s*>\s?/, "")
			.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 $2")
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
			.replace(/\*\*(.+?)\*\*/g, "$1")
			.replace(/__(.+?)__/g, "$1")
			.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1$2")
			.replace(/~~(.+?)~~/g, "$1")
			.replace(/`([^`]+)`/g, "$1");
		out.push(line);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Split text into chunks of at most `max` chars, preferring paragraph / line boundaries. */
export function splitMessage(text: string, max: number): string[] {
	const chunks: string[] = [];
	let rest = text.trim();
	while (rest.length > max) {
		const window = rest.slice(0, max);
		let cut = window.lastIndexOf("\n\n");
		if (cut < max * 0.4) cut = window.lastIndexOf("\n");
		if (cut < max * 0.4) cut = Math.max(window.lastIndexOf("。"), window.lastIndexOf("！"), window.lastIndexOf("？"), window.lastIndexOf(". "));
		if (cut < max * 0.4) cut = max - 1;
		chunks.push(rest.slice(0, cut + 1).trim());
		rest = rest.slice(cut + 1).trim();
	}
	if (rest) chunks.push(rest);
	return chunks;
}

export const NO_REPLY = "<NO_REPLY>";

/** Normalise a model reply; returns undefined when nothing should be sent. */
export function prepareReply(raw: string, botName?: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed || trimmed.includes(NO_REPLY)) return undefined;
	let text = stripMarkdown(trimmed);
	// Models sometimes imitate the input format: "[14:03] Pi(88888): ..." or "Pi：...".
	text = text.replace(/^\[\d{1,2}:\d{2}\]\s*[^\n:：]{0,30}?(\([^)\n]{1,40}\))?\s*[:：]\s*/, "");
	if (botName) {
		const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		text = text.replace(new RegExp(`^${escaped}\\s*[:：]\\s*`), "");
	}
	return text.trim() || undefined;
}
