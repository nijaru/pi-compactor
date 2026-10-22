import { expect, test } from "bun:test";
import { InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionContext, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheState } from "./expiry";
import register from "./index";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean) {
	const end = Date.now() + 2_000;
	while (!condition() && Date.now() < end) await delay(5);
	expect(condition()).toBe(true);
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

type Options = { first?: boolean; ttl?: "unknown" | "expired"; hold?: boolean; cancel?: boolean; abortRun?: boolean };
async function fixture(options: Options = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-compactor-expiry-sdk-"));
	const settings = {
		compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
		compactor: { compactBeforeExpiry: true, minContextTokens: 0, leadTimeSeconds: 1 },
	};
	const settingsManager = SettingsManager.inMemory(settings);
	const gate = deferred();
	const compactGate = deferred();
	const generations: Array<{ reads: number; requests: number; compactions: number; failures: number }> = [];
	let state: CacheState = { version: 1, cycle: "initial", available: false, reason: "no cached request", cachedTokens: 0, inputTokens: 0 };
	let cycle = 0;
	let bound: { session: string; model: string | undefined } | undefined;
	const bind = (ctx: ExtensionContext) => { bound = { session: ctx.sessionManager.getSessionId(), model: ctx.model?.id }; };
	// This contract double supplies saved cached-only summaries, not a mocked
	// ctx.compact: the real SDK owns aborts, hook ordering, persistence and dispose.
	const companion: ExtensionFactory = pi => {
		const counts = { reads: 0, requests: 0, compactions: 0, failures: 0 };
		generations.push(counts);
		pi.on("session_start", (_event, ctx) => { bind(ctx); state.available = false; });
		pi.on("session_shutdown", () => { bound = undefined; });
		pi.on("turn_end", (_event, ctx) => {
			bind(ctx);
			state = {
				version: 1, cycle: String(++cycle), available: true, reason: "cached summary ready",
				cachedTokens: 50_000, inputTokens: 60_000, ttlSource: "model",
				expiresAt: options.ttl === "unknown" ? undefined : Date.now() + (options.ttl === "expired" ? -1 : 1_060),
			};
		});
		pi.on("session_compact", () => { state.available = false; });
		pi.events.on("pi-provider-compaction:cache-state", value => {
			const request = value as { context: ExtensionContext; respond: (state: CacheState) => void };
			counts.reads++;
			if (request.context.sessionManager.getSessionId() === bound?.session
				&& request.context.model?.id === bound?.model) request.respond(state);
		});
		pi.events.on("pi-provider-compaction:compact-before-expiry", value => {
			const request = value as { cycle: string; context: ExtensionContext; isCurrent: () => boolean; run: () => Promise<boolean>; respond: (value: Promise<boolean>) => void };
			counts.requests++;
			request.respond((async () => {
				if (options.hold) await gate.promise;
				try {
					if (!request.isCurrent() || !state.available || request.cycle !== state.cycle || !state.expiresAt || state.expiresAt <= Date.now()) return false;
					return await request.run();
				} catch { counts.failures++; return false; }
			})());
		});
		pi.on("session_before_compact", async event => {
			counts.compactions++;
			if (options.cancel) return { cancel: true };
			if (options.abortRun) {
				await Promise.race([compactGate.promise, new Promise<void>(resolve => event.signal.addEventListener("abort", () => resolve(), { once: true }))]);
				if (event.signal.aborted) return { cancel: true };
			}
			return { compaction: { summary: "Cached task state.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
		});
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: options.first ? [companion, register] : [register, companion],
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false,
	});
	const faux = fauxProvider();
	modelRuntime.registerNativeProvider(faux.provider);
	const { session } = await createAgentSession({
		cwd: directory, agentDir: directory, model: faux.getModel(), modelRuntime, settingsManager,
		sessionManager: SessionManager.inMemory(directory), resourceLoader, noTools: "builtin",
	});
	const errors: unknown[] = [];
	await session.bindExtensions({ onError: error => errors.push(error) });
	return {
		session, faux, errors, gate, compactGate, generations,
		get counts() { return generations[generations.length - 1]; },
		warm: (expiresAt: number) => { state = { ...state, cycle: String(++cycle), expiresAt }; },
		branch: () => session.sessionManager.getBranch().filter(entry => entry.type === "compaction"),
		cleanup: async () => { gate.resolve(); compactGate.resolve(); session.dispose(); await rm(directory, { recursive: true, force: true }); },
	};
}

test.each([false, true])("SDK idle expiry persists exactly once with no continuation, companion first=%s", async first => {
	const f = await fixture({ first });
	try {
		f.faux.setResponses([fauxAssistantMessage("Task complete.")]);
		await f.session.prompt("Finish the task.");
		expect(f.branch()).toHaveLength(0);
		await until(() => f.branch().length === 1);
		await delay(90);
		expect(f.counts.requests).toBe(1);
		expect(f.counts.compactions).toBe(1);
		expect(f.faux.state.callCount).toBe(1);
		expect(f.session.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "pi-compactor-resume")).toBe(false);
		expect(f.errors).toEqual([]);
	} finally { await f.cleanup(); }
});

test.each(["unknown", "expired"] as const)("SDK idle expiry skips %s TTL", async ttl => {
	const f = await fixture({ ttl });
	try {
		f.faux.setResponses([fauxAssistantMessage("Done.")]);
		await f.session.prompt("Finish.");
		await delay(100);
		expect(f.counts.requests).toBe(0);
		expect(f.branch()).toHaveLength(0);
		expect(f.errors).toEqual([]);
	} finally { await f.cleanup(); }
});

test("SDK idle refresh observes a newer warmer cycle before firing", async () => {
	const f = await fixture();
	try {
		f.faux.setResponses([fauxAssistantMessage("Done.")]);
		await f.session.prompt("Finish.");
		f.warm(Date.now() + 1_250);
		await delay(120);
		expect(f.counts.requests).toBe(0);
		await until(() => f.branch().length === 1);
		expect(f.counts.requests).toBe(1);
		expect(f.errors).toEqual([]);
	} finally { await f.cleanup(); }
});

test.each(["pending input", "manual compact", "dispose", "reload"])("SDK fences delayed expiry authorization after %s", async race => {
	const f = await fixture({ hold: true });
	try {
		f.faux.setResponses([fauxAssistantMessage("Done.")]);
		await f.session.prompt("Finish.");
		await until(() => f.counts.requests === 1);
		const old = f.counts;
		if (race === "pending input") await f.session.followUp("Queued user input");
		if (race === "manual compact") await f.session.compact();
		if (race === "dispose") f.session.dispose();
		if (race === "reload") await f.session.reload();
		const reads = old.reads;
		f.gate.resolve();
		await delay(100);
		expect(f.branch()).toHaveLength(race === "manual compact" ? 1 : 0);
		expect(old.reads).toBe(reads);
		expect(old.compactions).toBe(race === "manual compact" ? 1 : 0);
		expect(f.faux.state.callCount).toBe(1);
		expect(f.errors).toEqual([]);
	} finally { await f.cleanup(); }
});

test.each([true, false])("SDK idle compaction abort/cancel has no fallback or resume (active abort=%s)", async abortRun => {
	const f = await fixture({ abortRun, cancel: !abortRun });
	try {
		f.faux.setResponses([fauxAssistantMessage("Done.")]);
		await f.session.prompt("Finish.");
		await until(() => f.counts.compactions === 1);
		if (abortRun) await f.session.abort();
		await until(() => f.counts.failures === 1);
		expect(f.branch()).toHaveLength(0);
		expect(f.faux.state.callCount).toBe(1);
		expect(f.session.messages.some(message => message.role === "custom")).toBe(false);
		expect(f.errors).toEqual([]);
	} finally { await f.cleanup(); }
});

test("SDK disposal cancels an armed idle timer even without session_shutdown", async () => {
	const f = await fixture();
	try {
		f.faux.setResponses([fauxAssistantMessage("Done.")]);
		await f.session.prompt("Finish.");
		const reads = f.counts.reads;
		f.session.dispose();
		await delay(120);
		expect(f.counts.requests).toBe(0);
		expect(f.counts.reads).toBe(reads);
		expect(f.errors).toEqual([]);
	} finally { await f.cleanup(); }
});

test("SDK tool compaction wins settlement without competing idle expiry", async () => {
	const f = await fixture();
	try {
		f.faux.setResponses([fauxAssistantMessage(fauxToolCall("compact", { continueAfterCompaction: false }), { stopReason: "toolUse" })]);
		await f.session.prompt("Compact at this task boundary.");
		await delay(100);
		expect(f.counts.compactions).toBe(1);
		expect(f.counts.requests).toBe(0);
		expect(f.branch()).toHaveLength(1);
		expect(f.faux.state.callCount).toBe(1);
		expect(f.errors).toEqual([]);
	} finally { await f.cleanup(); }
});
