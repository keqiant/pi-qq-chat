export type ChatKind = "group" | "private";

export interface ChatTarget {
	kind: ChatKind;
	/** group_id for groups, user_id for private chats */
	id: number;
}

export function chatKey(t: ChatTarget): string {
	return `${t.kind}:${t.id}`;
}

export interface PendingBatch<T> {
	target: ChatTarget;
	items: T[];
	firstAt: number;
	lastAt: number;
}

/**
 * Buffers incoming messages per chat. A chat becomes "ready" once no new
 * message arrived for `debounceMs` (or the batch waited `maxWaitMs` overall).
 * Batches are taken one at a time so replies are never routed to the wrong chat.
 */
export class ChatQueue<T> {
	private readonly batches = new Map<string, PendingBatch<T>>();
	private readonly debounceMs: number;
	private readonly maxWaitMs: number;

	constructor(debounceMs: number, maxWaitMs = Math.max(debounceMs * 4, 8000)) {
		this.debounceMs = debounceMs;
		this.maxWaitMs = maxWaitMs;
	}

	push(target: ChatTarget, item: T, now = Date.now()): void {
		const key = chatKey(target);
		const b = this.batches.get(key);
		if (b) {
			b.items.push(item);
			b.lastAt = now;
		} else {
			this.batches.set(key, { target, items: [item], firstAt: now, lastAt: now });
		}
	}

	get size(): number {
		let n = 0;
		for (const b of this.batches.values()) n += b.items.length;
		return n;
	}

	private isReady(b: PendingBatch<T>, now: number): boolean {
		return now - b.lastAt >= this.debounceMs || now - b.firstAt >= this.maxWaitMs;
	}

	/** Remove and return the oldest ready batch, if any. */
	takeReady(now = Date.now()): PendingBatch<T> | undefined {
		let best: [string, PendingBatch<T>] | undefined;
		for (const entry of this.batches) {
			if (!this.isReady(entry[1], now)) continue;
			if (!best || entry[1].firstAt < best[1].firstAt) best = entry;
		}
		if (!best) return undefined;
		this.batches.delete(best[0]);
		return best[1];
	}

	/** Milliseconds until the next batch becomes ready, or undefined when empty. */
	msUntilReady(now = Date.now()): number | undefined {
		let min: number | undefined;
		for (const b of this.batches.values()) {
			const wait = Math.max(0, Math.min(b.lastAt + this.debounceMs, b.firstAt + this.maxWaitMs) - now);
			min = min === undefined ? wait : Math.min(min, wait);
		}
		return min;
	}

	clear(): void {
		this.batches.clear();
	}
}
