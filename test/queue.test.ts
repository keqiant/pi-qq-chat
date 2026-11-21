import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatQueue } from "../src/queue.ts";

const g = { kind: "group" as const, id: "1" };
const p = { kind: "private" as const, id: "2" };

test("batches are debounced per chat", () => {
	const q = new ChatQueue<string>(1000, 10_000);
	q.push(g, "a", 0);
	q.push(g, "b", 500);
	assert.equal(q.takeReady(1200), undefined);
	assert.equal(q.msUntilReady(1200), 300);
	const b = q.takeReady(1500);
	assert.deepEqual(b?.items, ["a", "b"]);
	assert.equal(q.size, 0);
});

test("oldest ready chat goes first; chats never mix", () => {
	const q = new ChatQueue<string>(100, 10_000);
	q.push(p, "p1", 10);
	q.push(g, "g1", 0);
	q.push(p, "p2", 20);
	const first = q.takeReady(1000);
	assert.deepEqual(first?.target, g);
	assert.deepEqual(first?.items, ["g1"]);
	const second = q.takeReady(1000);
	assert.deepEqual(second?.target, p);
	assert.deepEqual(second?.items, ["p1", "p2"]);
});

test("maxWait forces a busy chat to flush", () => {
	const q = new ChatQueue<number>(1000, 3000);
	for (let t = 0; t <= 3000; t += 500) q.push(g, t, t);
	assert.ok(q.takeReady(3000));
});
