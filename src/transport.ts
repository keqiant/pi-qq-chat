import type { ChatTarget } from "./queue.ts";

/** A platform-independent incoming message. */
export interface IncomingMessage {
	/** Where a reply to this message goes. */
	target: ChatTarget;
	/** Primary sender ID (QQ number for OneBot, openid for the official bot). */
	userId: string;
	/** Every ID that identifies the sender (used to match admins / whitelists). */
	userIds: string[];
	userName: string;
	/** Message rendered as plain text ("@你", "[图片]" placeholders, ...). */
	text: string;
	imageUrls: string[];
	mentionsSelf: boolean;
	/** Platform message ID; the official bot needs it to reply (passive message). */
	messageId: string;
	/** Unix seconds. */
	time: number;
}

export interface SendOptions {
	/** Message being answered. Required by the official bot for passive replies. */
	replyTo?: string;
	/** Quote `replyTo` in the first chunk. */
	quote?: boolean;
}

export interface TransportHandlers {
	onMessage(message: IncomingMessage): void;
	log(message: string): void;
}

export interface ChatTransport {
	readonly name: string;
	readonly connected: boolean;
	/** Platform-specific rules appended to the qq_chat prompt section. */
	readonly promptHints: readonly string[];
	/** How a user ID appears in the transcript shown to the model. */
	displayUserId(id: string): string;
	/** How a chat appears in the batch header shown to the model. */
	displayChatId(target: ChatTarget): string;
	start(): void;
	stop(): void;
	/** Send `chunks` in order; throws if a chunk could not be delivered. */
	send(target: ChatTarget, chunks: string[], options: SendOptions): Promise<void>;
}
