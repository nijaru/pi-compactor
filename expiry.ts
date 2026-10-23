import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Synchronous companion bus response; the provider owns cache/session/model validity. */
export interface CacheState {
	version: 1;
	cycle: string;
	available: boolean;
	reason: string;
	expiresAt?: number;
	ttlSource?: "model";
	cachedTokens: number;
	inputTokens: number;
}

export interface ExpirySettings {
	compactBeforeExpiry: boolean;
	leadTimeSeconds: number;
	minContextTokens: number;
	compactionEnabled: boolean;
}

export function readExpirySettings(settings: { compactor?: unknown; compaction?: { enabled?: boolean } }): ExpirySettings {
	const raw = settings.compactor;
	const value = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
	return {
		compactBeforeExpiry: value.compactBeforeExpiry === true,
		// Leave enough time for the summary, without scheduling far ahead of expiry.
		leadTimeSeconds: typeof value.leadTimeSeconds === "number" && Number.isFinite(value.leadTimeSeconds)
			? Math.min(300, Math.max(1, value.leadTimeSeconds)) : 30,
		minContextTokens: typeof value.minContextTokens === "number" && Number.isSafeInteger(value.minContextTokens) && value.minContextTokens >= 0
			? value.minContextTokens : 50_000,
		compactionEnabled: settings.compaction?.enabled !== false,
	};
}

function validState(value: unknown): value is CacheState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Partial<CacheState>;
	return state.version === 1 && typeof state.cycle === "string"
		&& typeof state.available === "boolean" && typeof state.reason === "string"
		&& typeof state.cachedTokens === "number" && Number.isFinite(state.cachedTokens) && state.cachedTokens >= 0
		&& typeof state.inputTokens === "number" && Number.isFinite(state.inputTokens) && state.inputTokens >= 0
		&& (state.expiresAt === undefined || Number.isFinite(state.expiresAt))
		&& (state.ttlSource === undefined || state.ttlSource === "model");
}

export function readCacheState(pi: Pick<ExtensionAPI, "events">, context: ExtensionContext): CacheState | undefined {
	let state: CacheState | undefined;
	pi.events.emit("pi-provider-compaction:cache-state", {
		context,
		respond: (value: unknown) => { if (validState(value)) state = { ...value }; },
	});
	return state;
}

// Poll only between runs: Pi's idle warmer can replace a cache cycle without an
// extension lifecycle event. A fresh state read at every tick also handles sleep.
const REFRESH_MS = 1_000;
type Timer = ReturnType<typeof setTimeout>;
export interface ExpiryClock {
	now(): number;
	setTimeout(callback: () => void, delay: number): Timer;
	clearTimeout(timer: Timer): void;
}
const clock: ExpiryClock = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout };

type IdleOwner = {
	context: ExtensionContext;
	session: string;
	model: string | undefined;
};
const modelKey = (ctx: ExtensionContext) => ctx.model && `${ctx.model.provider}/${ctx.model.id}`;

/** Owns only idle observation/timing, never the tool's task-boundary policy. */
export class IdleCacheExpiry {
	private owner?: IdleOwner;
	private timer?: Timer;
	private attempted = new Set<string>();
	private settings = readExpirySettings({});

	constructor(
		private pi: Pick<ExtensionAPI, "events" | "getSettings">,
		private blocked: () => boolean,
		private run: (ctx: ExtensionContext, isCurrent: () => boolean) => Promise<boolean>,
		private time: ExpiryClock = clock,
	) {}

	private refreshSettings(): void { this.settings = readExpirySettings(this.pi.getSettings()); }

	private enabled(): boolean { return this.settings.compactBeforeExpiry && this.settings.compactionEnabled; }

	stop(): void {
		if (this.timer !== undefined) this.time.clearTimeout(this.timer);
		this.timer = undefined;
		this.owner = undefined;
	}

	reset(): void {
		this.stop();
		this.attempted.clear();
	}

	start(ctx: ExtensionContext): void {
		this.stop();
		const owner = { context: ctx, session: ctx.sessionManager.getSessionId(), model: modelKey(ctx) };
		this.owner = owner;
		this.tick(owner);
	}

	private current(owner: IdleOwner): boolean {
		return this.owner === owner && owner.session === owner.context.sessionManager.getSessionId()
			&& owner.model === modelKey(owner.context);
	}

	private canRun(owner: IdleOwner): boolean {
		return this.current(owner) && owner.context.isIdle() && !owner.context.hasPendingMessages() && !this.blocked();
	}

	private schedule(owner: IdleOwner, delay = REFRESH_MS): void {
		if (!this.current(owner)) return;
		this.timer = this.time.setTimeout(() => { this.timer = undefined; this.tick(owner); }, delay);
		this.timer.unref?.();
	}

	private eligible(ctx: ExtensionContext, state: CacheState | undefined, attempted = true): boolean {
		if (!this.enabled() || !state?.available || state.expiresAt === undefined
			|| state.expiresAt <= this.time.now() || state.cachedTokens <= 0) return false;
		const tokens = ctx.getContextUsage()?.tokens;
		const actual = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : state.inputTokens;
		return actual >= this.settings.minContextTokens && (!attempted || !this.attempted.has(state.cycle));
	}

	private tick(owner: IdleOwner): void {
		if (!this.current(owner)) return;
		this.refreshSettings();
		if (!this.enabled()) {
			this.stop();
			return;
		}
		const ctx = owner.context;
		if (!this.canRun(owner)) {
			this.schedule(owner);
			return;
		}
		const state = readCacheState(this.pi, ctx);
		if (!this.eligible(ctx, state)) {
			this.schedule(owner);
			return;
		}
		const delay = state!.expiresAt! - this.time.now() - this.settings.leadTimeSeconds * 1_000;
		if (delay > 0) {
			this.schedule(owner, Math.min(REFRESH_MS, delay));
			return;
		}
		// Consume before emitting: failed, declined, and missing listeners must not
		// retry this cycle. Only a successful newer request/warm grants another try.
		this.attempted.add(state!.cycle);
		void this.fire(owner, state!).catch(() => {
			// No request/error text: provider failures can contain private payloads.
			this.schedule(owner);
		});
	}

	private async fire(owner: IdleOwner, state: CacheState): Promise<void> {
		let result: Promise<boolean> | undefined;
		let invoked = false;
		let responding = true;
		this.pi.events.emit("pi-provider-compaction:compact-before-expiry", {
			context: owner.context,
			cycle: state.cycle,
			// This guard remains valid during compaction: isIdle/blocked are only
			// admission checks, since our own request makes the session busy.
			isCurrent: () => {
				if (!this.current(owner) || owner.context.hasPendingMessages()) return false;
				this.refreshSettings();
				return this.enabled();
			},
			run: async () => {
				// A companion may await preparation before running. Recheck both our
				// ownership and its current cycle/TTL immediately before ctx.compact.
				if (invoked) return false;
				invoked = true;
				// respond() must happen synchronously, even if run() was called while
				// evaluating its promise argument. No response means no authorization.
				await Promise.resolve();
				if (!result || !this.canRun(owner)) return false;
				this.refreshSettings();
				const fresh = readCacheState(this.pi, owner.context);
				if (fresh?.cycle !== state.cycle || !this.eligible(owner.context, fresh, false)) return false;
				return this.run(owner.context, () => this.current(owner));
			},
			respond: (promise: Promise<boolean>) => {
				const safe = Promise.resolve(promise);
				// Drain even a rejected duplicate/late response without detaching it.
				void safe.catch(() => {});
				if (responding && !result) result = safe;
			},
		});
		responding = false;
		if (result) await result;
		this.schedule(owner);
	}
}
