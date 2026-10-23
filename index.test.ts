import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, createEventBus } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	hintPercent,
	isTransientError,
	isUsableCompactionResult,
	readModelSelectors,
	shouldInject,
} from "./policy";
import registerExtension from "./index";

const temporaryDirectories: string[] = [];
const projectConfigDir = (directory: string) => join(directory, CONFIG_DIR_NAME);

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fixture(overrides: Partial<ExtensionAPI> = {}) {
	const handlers = new Map<string, (...args: any[]) => any>();
	let tool: any;
	registerExtension({
		events: createEventBus(),
		getFlag: () => undefined,
		getSettings: () => ({ compactor: { cacheStatus: false } }),
		registerCommand: () => undefined,
		registerFlag: () => undefined,
		registerTool: (definition: any) => { tool = definition; },
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		...overrides,
	} as unknown as ExtensionAPI);
	return { handlers, get tool() { return tool; } };
}

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

	test.each([
		{ usage: { tokens: 210_000, percent: 21, contextWindow: 1_000_000 }, text: "[ctx 210k/1.0m] [>200k]" },
		{ usage: { tokens: null, percent: 64, contextWindow: 200_000 }, text: "[ctx ?/200k (64%)]" },
	])("context hint conveys measured usage: $text", ({ usage, text }) => {
		const { handlers } = fixture();
		const event = { messages: [] as Array<{ content: string }> };
		handlers.get("context")!(event, { getContextUsage: () => usage });
		expect(event.messages).toEqual([expect.objectContaining({ content: text })]);
	});
});

test("a failed resume delivery does not block the next compact request", async () => {
	const f = fixture({ sendMessage: () => { throw new Error("extension inactive"); } });
	await f.tool.execute("1", { continueAfterCompaction: true });
	const ctx = {
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => "test" },
		ui: { setStatus: () => undefined },
		compact: ({ onComplete }: { onComplete: () => void }) => onComplete(),
	} as unknown as ExtensionContext;
	await f.handlers.get("agent_settled")!({ aborted: false }, ctx);
	await expect(f.tool.execute("2", { continueAfterCompaction: false })).resolves.toMatchObject({
		content: [expect.objectContaining({ text: expect.stringContaining("no follow-up turn") })],
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
	test.each([{ aborted: false }, { aborted: true }])("configured model preserves auth and cancellation (abort=$aborted)", async ({ aborted }) => {
		const { handlers } = fixture({ getFlag: () => "custom/summary" });
		const controller = new AbortController();
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
		const context = {
			modelRegistry: {
				find: () => model,
				getApiKeyAndHeaders: async () => {
					if (aborted) controller.abort();
					return {
						ok: true,
						apiKey: "resolved-key",
						headers: { "x-test": "value", "x-delete": null },
						baseUrl: "https://resolved.example/v1",
						env: { REGION: "test" },
					};
				},
				getProvider: () => provider,
			},
		} as unknown as ExtensionContext;
		const beforeCompact = handlers.get("session_before_compact");
		const result = await beforeCompact!({
			reason: "manual",
			customInstructions: "preserve decisions",
			signal: controller.signal,
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

		if (aborted) {
			expect(result).toEqual({ cancel: true });
			expect(streamCalls).toEqual([]);
			return;
		}
		expect(result?.compaction.summary).toBe("runtime summary");
		expect(streamCalls).toHaveLength(1);
		expect(streamCalls[0].model.baseUrl).toBe("https://resolved.example/v1");
		expect(streamCalls[0].options).toMatchObject({
			apiKey: "resolved-key",
			env: { REGION: "test" },
		});
		// `null` deletes a provider default header; stripping it would silently
		// restore the header the resolved auth config disabled.
		expect(streamCalls[0].options.headers).toEqual({ "x-test": "value", "x-delete": null });
	});
});
