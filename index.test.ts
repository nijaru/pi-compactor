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
			sendUserMessage: (message: string) => sentMessages.push(message),
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		expect(tool.executionMode).toBe("sequential");

		const context = {
			isIdle: () => true,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;
		const first = await tool.execute("one", {}, undefined, undefined, context);
		const second = await tool.execute("two", {}, undefined, undefined, context);
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
		expect(sentMessages).toEqual(["Continue."]);
		const third = await tool.execute("three", {}, undefined, undefined, context);
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
		const fourth = await tool.execute("four", {}, undefined, undefined, context);
		expect(fourth.isError).toBeUndefined();
		expect(compactRequests).toHaveLength(2);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(3);
		expect(sentMessages).toEqual(["Continue.", "Compaction failed (provider failed). Continue without compaction."]);
	});
	test("waits for the agent to settle before sending the recovery prompt", async () => {
		const compactRequests: Array<{ onComplete: () => void; onError: (error: Error) => void }> = [];
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 0));
		const sentMessages: Array<[string, unknown?]> = [];
		let idle = false;
		let tool: any;
		const pi = {
			getFlag: () => undefined,
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
			registerFlag: () => undefined,
			registerTool: (definition: unknown) => {
				tool = definition;
			},
			sendUserMessage: (message: string, options?: unknown) => sentMessages.push([message, options]),
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		const context = {
			isIdle: () => idle,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;

		await tool.execute("one", {}, undefined, undefined, context);
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
		const duplicate = await tool.execute("two", {}, undefined, undefined, context);
		expect(duplicate.isError).toBe(true);

		idle = true;
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(sentMessages).toEqual([["Continue.", undefined]]);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(sentMessages).toHaveLength(1);
	});

	test("prioritizes a pending manual compaction over Pi threshold compaction", async () => {
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
			sendUserMessage: (message: string) => sentMessages.push(message),
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		const context = {
			isIdle: () => true,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;

		const result = await tool.execute("one", {}, undefined, undefined, context);
		const beforeCompact = handlers.get("session_before_compact");
		expect(beforeCompact).toBeDefined();
		expect(await beforeCompact!({ reason: "threshold" }, context)).toEqual({ cancel: true });
		await flushTimers();
		expect(result.terminate).toBe(true);
		expect(compactRequests).toHaveLength(0);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(1);

		compactRequests[0].onComplete();
		await flushTimers();
		expect(sentMessages).toEqual(["Continue."]);
	});

	test("continues normally when Pi already compacted before the manual request", async () => {
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
			sendUserMessage: (message: string) => sentMessages.push(message),
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		const context = {
			isIdle: () => true,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;

		await tool.execute("one", {}, undefined, undefined, context);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(1);
		compactRequests[0].onError(new Error("Already compacted"));
		await flushTimers();
		expect(sentMessages).toEqual(["Continue."]);
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
			sendUserMessage: (message: string) => sentMessages.push(message),
		} as unknown as ExtensionAPI;

		const { default: registerExtension } = await import("./index");
		registerExtension(pi);
		const context = {
			isIdle: () => true,
			compact: (options: { onComplete: () => void; onError: (error: Error) => void }) => compactRequests.push(options),
		} as unknown as ExtensionContext;

		await tool.execute("one", {}, undefined, undefined, context);
		handlers.get("session_compact")?.({ type: "session_compact" }, context);
		await flushTimers();
		expect(sentMessages).toEqual(["Continue."]);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(0);

		await tool.execute("two", {}, undefined, undefined, context);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		await flushTimers();
		expect(compactRequests).toHaveLength(1);
		handlers.get("session_compact")?.({ type: "session_compact" }, context);
		await flushTimers();
		expect(sentMessages).toEqual(["Continue.", "Continue."]);
		compactRequests[0].onComplete();
		await flushTimers();
		expect(sentMessages).toEqual(["Continue.", "Continue."]);
	});
});
