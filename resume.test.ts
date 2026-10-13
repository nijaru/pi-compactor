import { afterEach, expect, jest, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import register, { RESUME_ACK_TIMEOUT_MS } from "./index";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const stop of cleanup.splice(0)) stop();
	jest.useRealTimers();
});

async function resumeFixture() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const requests: Array<{ onComplete: () => void }> = [];
	const messages: any[] = [];
	let idle = true;
	let tool: any;
	const ctx = { isIdle: () => idle, compact: (request: any) => requests.push(request) } as unknown as ExtensionContext;
	register({
		getFlag: () => undefined,
		registerFlag: () => {},
		registerTool: (definition: any) => { tool = definition; },
		on: (name: string, handler: any) => handlers.set(name, handler),
		sendMessage: (message: any) => { messages.push(message); idle = false; },
	} as unknown as ExtensionAPI);
	const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	cleanup.push(() => emit("session_shutdown"));
	jest.useFakeTimers();
	await tool.execute("compact", { continueAfterCompaction: true });
	emit("agent_settled", { aborted: false });
	jest.advanceTimersByTime(0);
	requests[0].onComplete();
	jest.advanceTimersByTime(0);
	return { messages, emit, idle: (value: boolean) => { idle = value; } };
}

// Pi can spend longer than the acknowledgement deadline in startup hooks,
// either before or after the compactor's hook runs. Neither delay means loss.
test.each(["before timeout", "after timeout"])("does not repeat a resume acknowledged %s", async when => {
	const f = await resumeFixture();
	const acknowledge = () => f.emit("before_agent_start", { messageType: "custom", message: f.messages[0] });
	if (when === "before timeout") acknowledge();
	jest.advanceTimersByTime(RESUME_ACK_TIMEOUT_MS + 1);
	jest.advanceTimersByTime(0);
	if (when === "after timeout") acknowledge();
	f.emit("agent_start");
	f.idle(true);
	f.emit("agent_settled", { aborted: false });
	jest.advanceTimersByTime(0);
	expect(f.messages).toHaveLength(1);
});

test.each(["before timeout", "after timeout"])("an unrelated run settling %s cannot acknowledge a dropped resume", async when => {
	const f = await resumeFixture();
	f.emit("before_agent_start", { messageType: "user", prompt: "Another request" });
	f.emit("before_agent_start", { messageType: "custom", message: { ...f.messages[0], details: { resumeId: "unrelated" } } });
	f.emit("agent_start");
	if (when === "after timeout") jest.advanceTimersByTime(RESUME_ACK_TIMEOUT_MS + 1);
	f.idle(true);
	f.emit("agent_settled", { aborted: false });
	if (when === "before timeout") jest.advanceTimersByTime(RESUME_ACK_TIMEOUT_MS + 1);
	jest.advanceTimersByTime(0);
	expect(f.messages).toHaveLength(2);
});
