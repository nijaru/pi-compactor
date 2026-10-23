import { expect, test } from "bun:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IdleCacheExpiry, readExpirySettings, type CacheState, type ExpiryClock } from "./expiry";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

class FakeClock implements ExpiryClock {
	value = 1_000_000;
	timers = new Map<ReturnType<typeof setTimeout>, { at: number; fn: () => void }>();
	now = () => this.value;
	setTimeout = (fn: () => void, delay: number) => {
		const timer = { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
		this.timers.set(timer, { at: this.value + delay, fn });
		return timer;
	};
	clearTimeout = (timer: ReturnType<typeof setTimeout>) => { this.timers.delete(timer); };
	async advance(ms: number, late = false) {
		const end = this.value + ms;
		if (late) this.value = end;
		while (true) {
			const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
			if (!next || next[1].at > end) break;
			this.value = Math.max(this.value, next[1].at);
			this.timers.delete(next[0]);
			next[1].fn();
			await flush();
		}
		this.value = end;
		await flush();
	}
}

type Request = { context: ExtensionContext; cycle: string; isCurrent: () => boolean; run: () => Promise<boolean>; respond: (result: Promise<boolean>) => void };
function fixture(compacted = true) {
	const time = new FakeClock();
	let state: CacheState = {
		version: 1, cycle: "one", available: true, reason: "cached summary prepared",
		expiresAt: time.now() + 60_000, ttlSource: "model", cachedTokens: 60_000, inputTokens: 60_000,
	};
	let settings: { compactor: unknown; compaction?: { enabled?: boolean } } = { compactor: { compactBeforeExpiry: true } };
	let idle = true, pending = false, blocked = false;
	let tokens: number | null = 60_000;
	let runs = 0, reads = 0;
	let status: string | undefined;
	const events = createEventBus();
	const ctx = {
		model: { provider: "test", id: "one" },
		sessionManager: { getSessionId: () => "session-one" },
		isIdle: () => idle, hasPendingMessages: () => pending,
		getContextUsage: () => ({ tokens }),
		ui: { setStatus: (_key: string, value: string | undefined) => { status = value; } },
	} as unknown as ExtensionContext;
	events.on("pi-provider-compaction:cache-state", (value) => {
		reads++;
		(value as { respond: (state: CacheState) => void }).respond(state);
	});
	const pi = { events, getSettings: () => settings } as Pick<ExtensionAPI, "events" | "getSettings">;
	const scheduler = new IdleCacheExpiry(pi, () => blocked, async () => { runs++; return compacted; }, time);
	let requests = 0;
	let handler = (request: Request) => request.respond(request.run());
	const unsubscribe = events.on("pi-provider-compaction:compact-before-expiry", value => {
		requests++;
		handler(value as Request);
	});
	return {
		time, scheduler, ctx, events, unsubscribe,
		start: () => scheduler.start(ctx),
		state: (value: Partial<CacheState>) => { state = { ...state, ...value }; },
		settings: (value: typeof settings) => { settings = value; },
		pending: (value: boolean) => { pending = value; },
		idle: (value: boolean) => { idle = value; },
		blocked: (value: boolean) => { blocked = value; },
		tokens: (value: number | null) => { tokens = value; },
		handler: (value: typeof handler) => { handler = value; },
		get runs() { return runs; }, get reads() { return reads; },
		get requests() { return requests; }, get status() { return status; },
	};
}

test("expiry settings are opt-in, typed, bounded preferences", () => {
	expect(readExpirySettings({})).toEqual({ compactBeforeExpiry: false, leadTimeSeconds: 30, minContextTokens: 50_000, compactionEnabled: true });
	for (const [value, expected] of [[-4, 1], [900, 300], [NaN, 30], [Infinity, 30], ["1", 30]]) {
		expect(readExpirySettings({ compactor: { leadTimeSeconds: value } }).leadTimeSeconds).toBe(expected as number);
	}
	expect(readExpirySettings({ compactor: { compactBeforeExpiry: "true", minContextTokens: -1 }, compaction: { enabled: false } }))
		.toMatchObject({ compactBeforeExpiry: false, minContextTokens: 50_000, compactionEnabled: false });
});

test("warmer cycles postpone idle expiry, then compact exactly once per cycle", async () => {
	const f = fixture();
	f.start();
	expect(f.status).toBeUndefined();
	await f.time.advance(29_000);
	f.state({ cycle: "warm", expiresAt: f.time.now() + 60_000 });
	await f.time.advance(29_000);
	expect(f.runs).toBe(0);
	await f.time.advance(1_000);
	expect(f.runs).toBe(1);
	await f.time.advance(10_000);
	expect(f.requests).toBe(1);
	f.state({ cycle: "new warm", expiresAt: f.time.now() + 10_000 });
	await f.time.advance(1_000);
	expect(f.runs).toBe(2);
	f.scheduler.stop();
	expect(f.time.timers.size).toBe(0);
	expect(f.status).toBeUndefined();
});

test.each([
	{ name: "unknown TTL", state: { expiresAt: undefined } },
	{ name: "expired TTL", state: { expiresAt: 1 } },
	{ name: "unavailable path", state: { available: false } },
	{ name: "no cached usage", state: { cachedTokens: 0 } },
	{ name: "actual usage below floor", tokens: 10 },
	{ name: "unknown usage below floor", tokens: null, state: { inputTokens: 10 } },
	{ name: "default opt-out", config: {} },
	{ name: "Pi compaction disabled", config: { compactBeforeExpiry: true }, enabled: false },
])("does not attempt $name", async ({ state, tokens, config, enabled }) => {
	const f = fixture();
	f.state({ expiresAt: f.time.now() + 10_000, ...state });
	if (tokens !== undefined) f.tokens(tokens);
	if (config !== undefined) f.settings({ compactor: config, compaction: { enabled } });
	f.start();
	await f.time.advance(20_000);
	expect(f.requests).toBe(0);
	expect(f.status).toBeUndefined();
	if (config !== undefined && (!config.compactBeforeExpiry || enabled === false)) {
		expect(f.reads).toBe(0);
		expect(f.time.timers.size).toBe(0);
	}
	f.scheduler.stop();
});

test("unknown actual usage can use the companion's measured input tokens", async () => {
	const f = fixture();
	f.tokens(null);
	f.state({ expiresAt: f.time.now() + 10_000 });
	f.start();
	await flush();
	expect(f.runs).toBe(1);
	f.scheduler.stop();
});

test("event-loop sleep past expiry never starts an expired request", async () => {
	const f = fixture();
	f.start();
	await f.time.advance(70_000, true);
	expect(f.requests).toBe(0);
	expect(f.status).toBeUndefined();
	f.scheduler.stop();
});

test.each(["pending", "busy", "compaction/resume"])("idle refresh does no cache work with %s", async condition => {
	const f = fixture();
	f.start();
	const reads = f.reads;
	f.pending(condition === "pending"); f.idle(condition !== "busy"); f.blocked(condition === "compaction/resume");
	await f.time.advance(35_000);
	expect(f.reads).toBe(reads);
	expect(f.requests).toBe(0);
	f.pending(false); f.idle(true); f.blocked(false);
	await f.time.advance(1_000);
	expect(f.runs).toBe(1);
	f.scheduler.stop();
});

test.each(["input", "stop", "warm", "expiry", "manual"])("delayed provider authorization rechecks %s before run", async race => {
	const f = fixture();
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	f.handler(request => request.respond(gate.then(request.run)));
	f.state({ expiresAt: f.time.now() + 10_000 });
	f.start();
	if (race === "input") f.pending(true);
	if (race === "stop") f.scheduler.stop();
	if (race === "warm") f.state({ cycle: "warm", expiresAt: f.time.now() + 60_000 });
	if (race === "expiry") await f.time.advance(11_000, true);
	if (race === "manual") f.blocked(true);
	release();
	await flush();
	expect(f.runs).toBe(0);
	f.scheduler.stop();
});

test("failed or missing authorization never retries the same cycle", async () => {
	for (const response of ["reject", "decline", "missing", "run-without-response"]) {
		const f = fixture();
		f.handler(request => {
			if (response === "reject") request.respond(Promise.reject(new Error("private provider text")));
			if (response === "decline") request.respond(Promise.resolve(false));
			if (response === "run-without-response") void request.run();
		});
		if (response === "missing") f.unsubscribe();
		f.state({ expiresAt: f.time.now() + 20_000 });
		f.start();
		await f.time.advance(10_000);
		expect(f.requests).toBe(response === "missing" ? 0 : 1);
		expect(f.runs).toBe(0);
		f.scheduler.stop();
	}
});

test("the shared transaction guard permits its own busy state but revokes on input/settings", async () => {
	const f = fixture();
	let current!: () => boolean;
	f.handler(request => { current = request.isCurrent; request.respond(request.run()); });
	f.state({ expiresAt: f.time.now() + 10_000 });
	f.start();
	await flush();
	f.idle(false); f.blocked(true);
	expect(current()).toBe(true);
	f.pending(true);
	expect(current()).toBe(false);
	f.pending(false);
	f.settings({ compactor: { compactBeforeExpiry: false } });
	expect(current()).toBe(false);
	f.scheduler.stop();
});

test("a failed compaction never retries the same cache cycle", async () => {
	const f = fixture(false);
	f.state({ expiresAt: f.time.now() + 20_000 });
	f.start();
	await f.time.advance(10_000);
	expect(f.runs).toBe(1);
	expect(f.requests).toBe(1);
	f.scheduler.stop();
});
