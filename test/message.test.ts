import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCQString, prepareReply, renderSegments, splitMessage, stripMarkdown } from "../src/message.ts";

test("parseCQString splits text and CQ codes", () => {
	const segs = parseCQString("你好[CQ:at,qq=42]看&#91;这&#93;[CQ:image,file=a.jpg,url=https://x/y.jpg]");
	assert.deepEqual(segs, [
		{ type: "text", data: { text: "你好" } },
		{ type: "at", data: { qq: "42" } },
		{ type: "text", data: { text: "看[这]" } },
		{ type: "image", data: { file: "a.jpg", url: "https://x/y.jpg" } },
	]);
});

test("renderSegments marks @self and collects images", () => {
	const r = renderSegments(
		[
			{ type: "at", data: { qq: "42" } },
			{ type: "text", data: { text: "看图" } },
			{ type: "image", data: { url: "https://x/y.jpg" } },
			{ type: "face", data: { id: "1" } },
		],
		42,
	);
	assert.equal(r.text, "@你 看图[图片][表情]");
	assert.equal(r.mentionsSelf, true);
	assert.deepEqual(r.imageUrls, ["https://x/y.jpg"]);
});

test("stripMarkdown flattens common syntax but keeps code", () => {
	const out = stripMarkdown("# 标题\n**粗体** 和 `代码` 和 [链接](https://a.b)\n- 项目\n```js\nconst a = 1;\n```");
	assert.equal(out, "标题\n粗体 和 代码 和 链接 (https://a.b)\n· 项目\nconst a = 1;");
});

test("splitMessage respects max length and prefers newlines", () => {
	const text = `${"a".repeat(60)}\n${"b".repeat(60)}\n${"c".repeat(60)}`;
	const chunks = splitMessage(text, 100);
	assert.deepEqual(chunks, ["a".repeat(60), "b".repeat(60), "c".repeat(60)]);
	for (const c of splitMessage("x".repeat(250), 100)) assert.ok(c.length <= 100);
	assert.equal(splitMessage("x".repeat(250), 100).join(""), "x".repeat(250));
});

test("prepareReply drops NO_REPLY and empty output", () => {
	assert.equal(prepareReply("<NO_REPLY>"), undefined);
	assert.equal(prepareReply("  "), undefined);
	assert.equal(prepareReply("**嗨**"), "嗨");
	assert.equal(prepareReply("[14:03] Pi(88888): 你好", "Pi"), "你好");
	assert.equal(prepareReply("Pi：你好", "Pi"), "你好");
	assert.equal(prepareReply("Pi 是我的名字", "Pi"), "Pi 是我的名字");
});
