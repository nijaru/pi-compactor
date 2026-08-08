import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	hintPercent,
	isTransientError,
	isUsableCompactionResult,
	readModelSelectors,
	shouldInject,
} from "./index";

const temporaryDirectories: string[] = [];
const projectConfigDir = (directory: string) => join(directory, CONFIG_DIR_NAME);

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("context hints", () => {
	test("uses a 50% floor for small windows and a token floor for large windows", () => {
		expect(hintPercent(128_000)).toBe(50);
		expect(hintPercent(1_000_000)).toBe(13);
		expect(hintPercent(200_000)).toBe(64);
		expect(hintPercent(100_000_000)).toBe(1);
		expect(shouldInject({ tokens: 64_000, percent: 50, contextWindow: 128_000 }, { tokens: 0, percent: 0 })).toBe(true);
		expect(shouldInject({ tokens: 100_000, percent: 50, contextWindow: 200_000 }, { tokens: 0, percent: 0 })).toBe(false);
		expect(shouldInject({ tokens: 127_000, percent: 63, contextWindow: 200_000 }, { tokens: 0, percent: 0 })).toBe(false);
		expect(shouldInject({ tokens: 128_000, percent: 64, contextWindow: 200_000 }, { tokens: 0, percent: 0 })).toBe(true);
		expect(shouldInject({ tokens: 128_000, percent: 1, contextWindow: 8_535_000 }, { tokens: 0, percent: 0 })).toBe(true);
		expect(shouldInject({ tokens: 127_000, percent: 12, contextWindow: 1_000_000 }, { tokens: 0, percent: 0 })).toBe(false);
		expect(shouldInject({ tokens: 128_000, percent: 12, contextWindow: 1_000_000 }, { tokens: 0, percent: 0 })).toBe(true);
	});

	test("throttles small increases and allows a reset after usage regresses", () => {
		const usage = { tokens: 70_000, percent: 54, contextWindow: 128_000 };
		expect(shouldInject(usage, { tokens: 64_000, percent: 50 })).toBe(false);
		expect(shouldInject({ ...usage, tokens: 72_000, percent: 56 }, { tokens: 64_000, percent: 50 })).toBe(true);
		expect(shouldInject({ tokens: 65_000, percent: 50, contextWindow: 128_000 }, { tokens: 70_000, percent: 55 })).toBe(true);
	});

	test("shows the percentage when the token count is unavailable", async () => {
		const handlers = new Map<string, (...args: any[]) => any>();
		const pi = {
			getFlag: () => undefined,
			on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
			registerFlag: () => undefined,
			registerTool: () => undefined,
		} as unknown as ExtensionAPI;
		const { default: registerExtension } = await import("./index");
		registerExtension(pi);

		const event = { messages: [] as Array<{ content: string }> };
		handlers.get("context")?.(event, {
			getContextUsage: () => ({ tokens: null, percent: 64, contextWindow: 200_000 }),
		} as unknown as ExtensionContext);

		expect(event.messages).toEqual([
			expect.objectContaining({ content: "[ctx ?/200k (64%)]" }),
		]);
	});

});

describe("model policy", () => {
	test("honors the flag and trusted project precedence", async () => {
		const directory = await mkdtemp(`${tmpdir()}/pi-compactor-`);
		temporaryDirectories.push(directory);
		await mkdir(projectConfigDir(directory));
		await writeFile(join(projectConfigDir(directory), "settings.json"), "{}");
		await writeFile(
			join(projectConfigDir(directory), "compaction-policy.json"),
			JSON.stringify({ models: ["project/provider", "project/provider", 12, "project/second"] }),
		);

		const projectContext = { cwd: directory, isProjectTrusted: () => true };
		expect(readModelSelectors({ getFlag: () => undefined }, projectContext)).toEqual([
			"project/provider",
			"project/second",
		]);
		expect(readModelSelectors({ getFlag: () => " flag/provider " }, projectContext)).toEqual(["flag/provider"]);
	});

	test("reads a trusted policy from an SDK-provided agent directory", async () => {
		const directory = await mkdtemp(`${tmpdir()}/pi-compactor-`);
		const agentDirectory = await mkdtemp(`${tmpdir()}/pi-compactor-agent-`);
		temporaryDirectories.push(directory, agentDirectory);
		await mkdir(projectConfigDir(directory));
		await writeFile(join(projectConfigDir(directory), "settings.json"), "{}");
		await writeFile(
			join(agentDirectory, "compaction-policy.json"),
			JSON.stringify({ models: ["sdk/provider"] }),
		);
		const safePath = `--${directory.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const sessionDir = join(agentDirectory, "sessions", safePath);

		expect(
			readModelSelectors(
				{ getFlag: () => undefined },
				{ cwd: directory, isProjectTrusted: () => true, sessionManager: { getSessionDir: () => sessionDir } },
			),
		).toEqual(["sdk/provider"]);
	});

	test("does not read a policy-only project directory even when trust reports true", async () => {
		const directory = await mkdtemp(`${tmpdir()}/pi-compactor-`);
		temporaryDirectories.push(directory);
		await mkdir(projectConfigDir(directory));
		await writeFile(
			join(projectConfigDir(directory), "compaction-policy.json"),
			JSON.stringify({ models: ["project-only/provider"] }),
		);

		const selectors = readModelSelectors(
			{ getFlag: () => undefined },
			{ cwd: directory, isProjectTrusted: () => true },
		);
		expect(selectors).not.toContain("project-only/provider");
	});

	test("bounds and normalizes policy selectors", async () => {
		const directory = await mkdtemp(`${tmpdir()}/pi-compactor-`);
		temporaryDirectories.push(directory);
		await mkdir(projectConfigDir(directory));
		await writeFile(join(projectConfigDir(directory), "settings.json"), "{}");
		await writeFile(
			join(projectConfigDir(directory), "compaction-policy.json"),
			JSON.stringify({ models: Array.from({ length: 12 }, (_, index) => `provider/model-${index}`) }),
		);

		expect(readModelSelectors({ getFlag: () => undefined }, { cwd: directory, isProjectTrusted: () => true })).toHaveLength(8);
	});
});

describe("compaction safety helpers", () => {
	test("accepts only non-empty summaries", () => {
		expect(isUsableCompactionResult({ summary: " useful " })).toBe(true);
		expect(isUsableCompactionResult({ summary: "   " })).toBe(false);
		expect(isUsableCompactionResult(undefined)).toBe(false);
	});

	test("classifies transient failures without retrying permanent ones", () => {
		expect(isTransientError(Object.assign(new Error("server failure"), { status: 503 }))).toBe(true);
		expect(isTransientError(Object.assign(new Error("insufficient_quota"), { status: 429 }))).toBe(false);
		expect(isTransientError(Object.assign(new Error("usage_limit_reached"), { status: 429 }))).toBe(false);
		expect(isTransientError(new Error("network connection reset"))).toBe(true);
		expect(isTransientError(Object.assign(new Error("bad request"), { status: 400 }))).toBe(false);
		expect(isTransientError(Object.assign(new Error("cancelled"), { name: "AbortError" }))).toBe(false);
	});
});

describe("configured compaction models", () => {
	test("uses the composed provider and preserves resolved endpoint/auth", async () => {
		const handlers = new Map<string, (...args: any[]) => any>();
		const streamCalls: Array<{ model: any; options: any }> = [];
		const model = {
			provider: "custom",
			id: "summary",
			api: "custom-api",
			maxTokens: 1024,
			reasoning: false,
		};
		const provider = {
			streamSimple: (requestModel: any, _context: unknown, options: unknown) => {
				streamCalls.push({ model: requestModel, options });
				return {
					result: async () => ({
						role: "assistant",
						content: [{ type: "text", text: "runtime summary" }],
						api: "custom-api",
						provider: "custom",
						model: "summary",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					}),
				};
			},
		};
		const pi = {
			getFlag: (name: string) => (name === "compaction-model" ? "custom/summary" : undefined),
			on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
			registerFlag: () => undefined,
			registerTool: () => undefined,
		} as unknown as ExtensionAPI;
		const { default: registerExtension } = await import("./index");
		registerExtension(pi);

		const context = {
			modelRegistry: {
				find: () => model,
				getApiKeyAndHeaders: async () => ({
					ok: true,
					apiKey: "resolved-key",
					headers: { "x-test": "value", "x-delete": null },
					baseUrl: "https://resolved.example/v1",
					env: { REGION: "test" },
				}),
				getProvider: () => provider,
			},
		} as unknown as ExtensionContext;
		const beforeCompact = handlers.get("session_before_compact");
		const result = await beforeCompact!({
			reason: "manual",
			customInstructions: "preserve decisions",
			signal: new AbortController().signal,
			preparation: {
				firstKeptEntryId: "keep",
				messagesToSummarize: [{ role: "user", content: "old context", timestamp: Date.now() }],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
			},
		}, context);

		expect(result?.compaction.summary).toBe("runtime summary");
		expect(streamCalls).toHaveLength(1);
		expect(streamCalls[0].model.baseUrl).toBe("https://resolved.example/v1");
		expect(streamCalls[0].options).toMatchObject({
			apiKey: "resolved-key",
			headers: { "x-test": "value" },
			env: { REGION: "test" },
		});
	});
});

describe("compact tool lifecycle", () => {
	test("waits for settlement, serializes in-flight compactions, and resumes after completion", async () => {
		const compactRequests: Array<{ onComplete: () => void; onError: (error: Error) => void }> = [];
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));
		const sentMessages: string[] = [];
		let tool: any;
		const pi = {
			getFlag: () => undefined,
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
			registerFlag: () => undefined,
			registerTool: (definition: unknown) => {
				tool = definition;
			},
			sendMessage: (message: any) => (sentMessages.push(typeof message === "string" ? message : message.content), Promise.resolve()),
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		expect(tool.executionMode).toBe("sequential");

		const context = {
			isIdle: () => true,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;
		const first = await tool.execute("one", { continueAfterCompaction: true }, undefined, undefined, context);
		const second = await tool.execute("two", { continueAfterCompaction: true }, undefined, undefined, context);
		expect(first.isError).toBeUndefined();
		expect(first.terminate).toBe(true);
		expect(second.isError).toBe(true);
		expect(compactRequests).toHaveLength(0);
		await flushTimers();
		expect(compactRequests).toHaveLength(0);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(1);

		compactRequests[0].onComplete();
		await flushTimers();
		compactRequests[0].onComplete();
		await flushTimers();
		expect(sentMessages).toEqual(["Resume only unfinished work; if none remains, give the final response and stop."]);
		const third = await tool.execute("three", { continueAfterCompaction: true }, undefined, undefined, context);
		expect(third.isError).toBeUndefined();
		expect(compactRequests).toHaveLength(1);
		await flushTimers();
		expect(compactRequests).toHaveLength(1);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(2);

		const originalConsoleError = console.error;
		console.error = () => undefined;
		compactRequests[1].onError(new Error("provider failed"));
		console.error = originalConsoleError;
		await flushTimers();
		const fourth = await tool.execute("four", { continueAfterCompaction: true }, undefined, undefined, context);
		expect(fourth.isError).toBeUndefined();
		expect(compactRequests).toHaveLength(2);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(3);
		expect(sentMessages).toEqual([
			"Resume only unfinished work; if none remains, give the final response and stop.",
			"Compaction failed; resume only unfinished work without compaction, then give the final response.",
		]);
	});
	test("does not start a follow-up when no unfinished work remains", async () => {
		const compactRequests: Array<{ onComplete: () => void; onError: (error: Error) => void }> = [];
		const handlers = new Map<string, (...args: any[]) => any>();
		const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));
		const sentMessages: string[] = [];
		let tool: any;
		const pi = {
			getFlag: () => undefined,
			on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
			registerFlag: () => undefined,
			registerTool: (definition: unknown) => {
				tool = definition;
			},
			sendMessage: (message: any) => (sentMessages.push(message.content), Promise.resolve()),
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		const context = {
			isIdle: () => true,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;

		const result = await tool.execute("one", { continueAfterCompaction: false }, undefined, undefined, context);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		compactRequests[0].onComplete();
		await flushTimers();
		expect(result.content[0].text).toContain("no follow-up turn");
		expect(sentMessages).toEqual([]);
	});

	test("waits for the agent to settle before sending the recovery prompt", async () => {
		const compactRequests: Array<{ onComplete: () => void; onError: (error: Error) => void }> = [];
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));
		const sentMessages: Array<[string, unknown?, boolean?]> = [];
		let idle = false;
		let tool: any;
		const pi = {
			getFlag: () => undefined,
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
			registerFlag: () => undefined,
			registerTool: (definition: unknown) => {
				tool = definition;
			},
			sendMessage: (message: any, options?: unknown) => (sentMessages.push([message.content, options, message.display]), Promise.resolve()),
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		const context = {
			isIdle: () => idle,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;

		await tool.execute("one", { continueAfterCompaction: true }, undefined, undefined, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(0);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(0);
		idle = true;
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(1);
		idle = false;
		compactRequests[0].onComplete();
		await flushTimers();
		expect(sentMessages).toEqual([]);
		const duplicate = await tool.execute("two", { continueAfterCompaction: true }, undefined, undefined, context);
		expect(duplicate.isError).toBe(true);

		idle = true;
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(sentMessages).toEqual([["Resume only unfinished work; if none remains, give the final response and stop.", { triggerTurn: true }, false]]);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(sentMessages).toHaveLength(1);
	});

	test("lets Pi threshold compaction win over a pending tool compaction", async () => {
		const handlers = new Map<string, (...args: any[]) => any>();
		const compactRequests: Array<{ onComplete: () => void; onError: (error: Error) => void }> = [];
		const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));
		const sentMessages: string[] = [];
		let tool: any;
		const pi = {
			getFlag: () => undefined,
			on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
			registerFlag: () => undefined,
			registerTool: (definition: unknown) => {
				tool = definition;
			},
			sendMessage: (message: any) => (sentMessages.push(typeof message === "string" ? message : message.content), Promise.resolve()),
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		const context = {
			isIdle: () => true,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;

		const result = await tool.execute("one", { continueAfterCompaction: true }, undefined, undefined, context);
		const beforeCompact = handlers.get("session_before_compact");
		expect(beforeCompact).toBeDefined();
		expect(await beforeCompact!({ reason: "threshold" }, context)).toBeUndefined();
		await flushTimers();
		expect(result.terminate).toBe(true);
		expect(compactRequests).toHaveLength(0);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(0);
		expect(sentMessages).toEqual([]);
	});

	test("resumes when Pi reports the compaction was already complete", async () => {
		const compactRequests: Array<{ onComplete: () => void; onError: (error: Error) => void }> = [];
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));
		const sentMessages: string[] = [];
		let tool: any;
		const pi = {
			getFlag: () => undefined,
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
			registerFlag: () => undefined,
			registerTool: (definition: unknown) => {
				tool = definition;
			},
			sendMessage: (message: any) => (sentMessages.push(typeof message === "string" ? message : message.content), Promise.resolve()),
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		const context = {
			isIdle: () => true,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;

		await tool.execute("one", { continueAfterCompaction: true }, undefined, undefined, context);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(1);
		compactRequests[0].onError(new Error("Already compacted"));
		await flushTimers();
		expect(sentMessages).toEqual(["Resume only unfinished work; if none remains, give the final response and stop."]);
	});

	test("does not resume from session_compact until its own callback completes", async () => {
		const compactRequests: Array<{ onComplete: () => void; onError: (error: Error) => void }> = [];
		const handlers = new Map<string, (...args: any[]) => any>();
		const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));
		const sentMessages: string[] = [];
		let tool: any;
		const pi = {
			getFlag: () => undefined,
			on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
			registerFlag: () => undefined,
			registerTool: (definition: unknown) => {
				tool = definition;
			},
			sendMessage: (message: any) => (sentMessages.push(typeof message === "string" ? message : message.content), Promise.resolve()),
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		const context = {
			isIdle: () => true,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;

		await tool.execute("one", { continueAfterCompaction: true }, undefined, undefined, context);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(1);
		const beforeCompact = handlers.get("session_before_compact");
		expect(await beforeCompact?.({ reason: "manual" }, context)).toBeUndefined();
		expect(await beforeCompact?.({ reason: "manual" }, context)).toEqual({ cancel: true });
		handlers.get("session_compact")?.({ reason: "manual", willRetry: false }, context);
		await flushTimers();
		expect(sentMessages).toEqual([]);

		compactRequests[0].onComplete();
		await flushTimers();
		expect(sentMessages).toEqual(["Resume only unfinished work; if none remains, give the final response and stop."]);
	});

	test("retries a failed recovery prompt without losing it", async () => {
		const compactRequests: Array<{ onComplete: () => void; onError: (error: Error) => void }> = [];
		const handlers = new Map<string, (...args: any[]) => any>();
		const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));
		const sentMessages: string[] = [];
		let sendAttempts = 0;
		let tool: any;
		const pi = {
			getFlag: () => undefined,
			on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
			registerFlag: () => undefined,
			registerTool: (definition: unknown) => {
				tool = definition;
			},
			sendMessage: (message: any) => {
				sendAttempts += 1;
				if (sendAttempts === 1) return Promise.reject(new Error("session not ready"));
				sentMessages.push(message.content);
				return Promise.resolve();
			},
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		const context = {
			isIdle: () => true,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;

		await tool.execute("one", { continueAfterCompaction: true }, undefined, undefined, context);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(1);

		const originalConsoleError = console.error;
		console.error = () => undefined;
		try {
			compactRequests[0].onComplete();
			await flushTimers();
			await flushTimers();
		} finally {
			console.error = originalConsoleError;
		}
		expect(sendAttempts).toBe(2);
		expect(sentMessages).toEqual([
			"Resume only unfinished work; if none remains, give the final response and stop.",
		]);
	});

	test("does not add a duplicate continuation to Pi's overflow retry", async () => {
		const compactRequests: Array<{ onComplete: () => void; onError: (error: Error) => void }> = [];
		const handlers = new Map<string, (...args: any[]) => any>();
		const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));
		const sentMessages: string[] = [];
		let tool: any;
		const pi = {
			getFlag: () => undefined,
			on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
			registerFlag: () => undefined,
			registerTool: (definition: unknown) => {
				tool = definition;
			},
			sendMessage: (message: any) => (sentMessages.push(typeof message === "string" ? message : message.content), Promise.resolve()),
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		const context = {
			isIdle: () => true,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;

		await tool.execute("one", { continueAfterCompaction: true }, undefined, undefined, context);
		handlers.get("session_before_compact")?.({ reason: "overflow", willRetry: true }, context);
		handlers.get("session_compact")?.({ reason: "overflow", willRetry: true }, context);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(0);
		expect(sentMessages).toEqual([]);
	});

	test("reconciles a competing successful compaction and ignores stale callbacks", async () => {
		const compactRequests: Array<{ onComplete: () => void; onError: (error: Error) => void }> = [];
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));
		const sentMessages: string[] = [];
		let tool: any;
		const pi = {
			getFlag: () => undefined,
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
			registerFlag: () => undefined,
			registerTool: (definition: unknown) => {
				tool = definition;
			},
			sendMessage: (message: any) => (sentMessages.push(typeof message === "string" ? message : message.content), Promise.resolve()),
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		const context = {
			isIdle: () => true,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;

		await tool.execute("one", { continueAfterCompaction: true }, undefined, undefined, context);
		handlers.get("session_compact")?.({ type: "session_compact" }, context);
		await flushTimers();
		expect(sentMessages).toEqual([]);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(0);

		await tool.execute("two", { continueAfterCompaction: true }, undefined, undefined, context);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(1);
		handlers.get("session_compact")?.({ type: "session_compact" }, context);
		await flushTimers();
		expect(sentMessages).toEqual([]);
		compactRequests[0].onComplete();
		await flushTimers();
		expect(sentMessages).toEqual([]);
	});

	test("invalidates deferred callbacks when the session lifecycle resets", async () => {
		const compactRequests: Array<{ onComplete: () => void; onError: (error: Error) => void }> = [];
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));
		const sentMessages: string[] = [];
		let tool: any;
		const pi = {
			getFlag: () => undefined,
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
			registerFlag: () => undefined,
			registerTool: (definition: unknown) => {
				tool = definition;
			},
			sendMessage: (message: any) => (sentMessages.push(typeof message === "string" ? message : message.content), Promise.resolve()),
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		const context = {
			isIdle: () => true,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;

		await tool.execute("one", { continueAfterCompaction: true }, undefined, undefined, context);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		handlers.get("session_start")?.({ type: "session_start" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(0);

		await tool.execute("two", { continueAfterCompaction: true }, undefined, undefined, context);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(1);
		handlers.get("session_start")?.({ type: "session_start" }, context);
		compactRequests[0].onComplete();
		await flushTimers();
		expect(sentMessages).toEqual([]);
	});
});
