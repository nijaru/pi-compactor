import { expect, test } from "bun:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import register from "./index";

function fixture() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const requests: Array<{ onComplete: () => void; onError: (error: Error) => void }> = [];
	const messages: any[] = [];
	let idle = true;
	let tool: any;
	const ctx = {
		isIdle: () => idle, hasPendingMessages: () => false,
		ui: { setStatus: () => undefined },
		sessionManager: { getSessionId: () => "resume-test" },
		compact: (request: any) => { requests.push(request); },
	} as unknown as ExtensionContext;
	register({
		events: createEventBus(),
		getFlag: () => undefined,
		getSettings: () => ({}),
		registerCommand: () => undefined,
		registerFlag: () => {},
		registerTool: (definition: any) => { tool = definition; },
		on: (name: string, handler: any) => handlers.set(name, handler),
		sendMessage: (message: any, options: any) => { messages.push({ ...message, options }); },
	} as unknown as ExtensionAPI);
	const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	return { messages, requests, emit, tool, idle: (value: boolean) => { idle = value; } };
}

test("serializes compactions through completion and exact busy-startup acknowledgement", async () => {
	const f = fixture();
	expect(f.tool.executionMode).toBe("sequential");
	await f.tool.execute("compact", { continueAfterCompaction: true });
	expect(f.requests).toHaveLength(0);
	await expect(f.tool.execute("duplicate", { continueAfterCompaction: true })).rejects.toThrow("already in progress");
	const settled = f.emit("agent_settled");
	expect(f.requests).toHaveLength(1);
	await f.emit("session_before_compact", { reason: "manual" });
	expect(await f.emit("session_before_compact", { reason: "manual" })).toEqual({ cancel: true });
	f.emit("session_compact");
	expect(f.messages).toHaveLength(0);
	f.requests[0].onComplete();
	await settled;
	// A repeated host callback cannot send a second continuation.
	f.requests[0].onComplete();
	expect(f.messages).toHaveLength(1);
	expect(f.messages[0]).toMatchObject({ display: false, options: { triggerTurn: true } });
	f.idle(false);
	for (const event of [
		{ messageType: "user", prompt: "unrelated" },
		{ messageType: "custom", message: { ...f.messages[0], details: { resumeId: "unrelated" } } },
	]) {
		f.emit("before_agent_start", event);
		await expect(f.tool.execute("duplicate", { continueAfterCompaction: true })).rejects.toThrow("already in progress");
	}
	f.emit("before_agent_start", { messageType: "custom", message: f.messages[0] });
	// The acknowledged continuation may itself request another compaction.
	await expect(f.tool.execute("next", { continueAfterCompaction: false })).resolves.toMatchObject({ terminate: true });
});

test.each(["session_start", "session_tree", "session_shutdown"])("%s fences pending and in-flight compaction callbacks", async reset => {
	const f = fixture();
	await f.tool.execute("compact", { continueAfterCompaction: true });
	f.emit(reset);
	await f.emit("agent_settled");
	expect(f.requests).toHaveLength(0);
	await f.tool.execute("compact", { continueAfterCompaction: true });
	const settled = f.emit("agent_settled");
	f.emit(reset);
	f.requests[0].onComplete();
	await settled;
	expect(f.messages).toHaveLength(0);
	await expect(f.tool.execute("next", { continueAfterCompaction: false })).resolves.toMatchObject({ terminate: true });
});

test("aborted settlement discards a tool request before compaction starts", async () => {
	const f = fixture();
	await f.tool.execute("compact", { continueAfterCompaction: true });
	await f.emit("agent_settled", { aborted: true });
	expect(f.requests).toHaveLength(0);
	expect(f.messages).toHaveLength(0);
	await expect(f.tool.execute("next", { continueAfterCompaction: false })).resolves.toMatchObject({ terminate: true });
});

test.each(["manual", "threshold", "overflow"])("competing %s compaction wins before settlement without a duplicate resume", async reason => {
	const f = fixture();
	await f.tool.execute("compact", { continueAfterCompaction: true });
	await f.emit("session_before_compact", { reason, willRetry: reason === "overflow" });
	f.emit("session_compact");
	await f.emit("agent_settled");
	expect(f.requests).toHaveLength(0);
	expect(f.messages).toHaveLength(0);
	await expect(f.tool.execute("next", { continueAfterCompaction: false })).resolves.toMatchObject({ terminate: true });
});

test("a saved competing compaction invalidates an unowned callback", async () => {
	const f = fixture();
	await f.tool.execute("compact", { continueAfterCompaction: true });
	const settled = f.emit("agent_settled");
	f.emit("session_compact");
	f.requests[0].onComplete();
	await settled;
	expect(f.messages).toHaveLength(0);
});

test.each([
	{ error: new Error("Already compacted"), resume: "Resume only unfinished work; if none remains, give the final response and stop." },
	{ error: new Error("provider failed"), resume: "Compaction failed; resume only unfinished work without compaction, then give the final response." },
	{ error: new Error("Compaction cancelled"), resume: undefined },
	{ error: Object.assign(new Error("aborted"), { name: "AbortError" }), resume: undefined },
])("compaction outcome controls recovery: $error.message", async ({ error, resume }) => {
	const f = fixture();
	await f.tool.execute("compact", { continueAfterCompaction: true });
	const settled = f.emit("agent_settled");
	f.requests[0].onError(error);
	await settled;
	expect(f.messages.map(message => message.content)).toEqual(resume ? [resume] : []);
});
