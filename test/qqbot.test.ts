import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeEvent } from "../src/qqbot.ts";

test("group @ event: mention prefix, ids, name", () => {
	const m = normalizeEvent("GROUP_AT_MESSAGE_CREATE", {
		id: "m1",
		group_openid: "G1",
		content: " 你好",
		timestamp: "2026-11-22T14:03:00+08:00",
		author: { member_openid: "U1", union_openid: "UN1", member_nickname: "小明" },
	});
	assert.ok(m);
	assert.deepEqual(m.target, { kind: "group", id: "G1" });
	assert.equal(m.text, "@你 你好");
	assert.equal(m.mentionsSelf, true);
	assert.equal(m.userName, "小明");
	assert.deepEqual(m.userIds, ["U1", "UN1"]);
	assert.equal(m.messageId, "m1");
	assert.equal(m.time, Date.parse("2026-11-22T14:03:00+08:00") / 1000);
});

test("full-mode group event: inline mentions, faces, attachments", () => {
	const m = normalizeEvent("GROUP_MESSAGE_CREATE", {
		id: "m2",
		group_openid: "G1",
		content: "<@BOT> 看 <@U2> 这个<faceType=1,faceId=\"13\",ext=\"x\">",
		author: { member_openid: "U1" },
		mentions: [
			{ member_openid: "BOT", is_you: true },
			{ member_openid: "U2", member_nickname: "小红" },
		],
		attachments: [
			{ content_type: "image/jpeg", url: "multimedia.nt.qq.com.cn/a.jpg" },
			{ content_type: "voice", asr_refer_text: "在吗" },
		],
	});
	assert.ok(m);
	assert.equal(m.text, "@你 看 @小红 这个[表情][图片][语音：在吗]");
	assert.equal(m.mentionsSelf, true);
	assert.deepEqual(m.imageUrls, ["https://multimedia.nt.qq.com.cn/a.jpg"]);
	assert.equal(m.userName, "群友");
});

test("c2c event targets the user; bot authors are dropped", () => {
	const m = normalizeEvent("C2C_MESSAGE_CREATE", { id: "m3", content: "hi", author: { user_openid: "P1", username: "阿强" } });
	assert.deepEqual(m?.target, { kind: "private", id: "P1" });
	assert.equal(m?.userName, "阿强");
	assert.equal(normalizeEvent("GROUP_MESSAGE_CREATE", { id: "m4", group_openid: "G", author: { bot: true, member_openid: "B" } }), undefined);
});
