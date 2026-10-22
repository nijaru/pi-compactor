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
	cacheStatus: boolean;
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
		cacheStatus: typeof value.cacheStatus === "boolean" ? value.cacheStatus : true,
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

export function cacheLabel(state: CacheState | undefined, now = Date.now()): string {
	if (!state) return "cache unavailable";
	if (state.expiresAt === undefined) return "cache TTL unknown";
	const seconds = Math.ceil((state.expiresAt - now) / 1_000);
	return seconds > 0 ? `cache ~${seconds}s (estimated TTL)` : "cache estimated TTL expired";
}

// Poll only between runs: Pi's idle warmer can replace a cache cycle without an
// extension lifecycle event. A fresh state read at every tick also handles sleep.
const REFRESH_MS = 1_000;
const STATUS_KEY = "pi-compactor-cache";
type Timer = ReturnType<typeof setTimeout>;
export interface ExpiryClock {
	now(): number;
	setTimeout(callback: () => void, delay: number): Timer;
	clearTimeout(timer: Timer): void;
}
const clock: ExpiryClock = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout };

type IdleOwner = {
	context: ExtensionContext;
	// Keep the cleanup capability, not a late read through an invalidated ctx.
	ui: Pick<ExtensionContext["ui"], "setStatus">;
	session: string;
	model: string | undefined;
};
const modelKey = (ctx: ExtensionContext) => ctx.model && `${ctx.model.provider}/${ctx.model.id}`;

/** Owns only idle observation/timing, never the tool's task-boundary policy. */
export class IdleCacheExpiry {
	private owner?: IdleOwner;
	private timer?: Timer;
	private attempted = new Set<string>();
	private reason = "not started";
	private settings = readExpirySettings({});

	constructor(
		private pi: Pick<ExtensionAPI, "events" | "getSettings">,
		private blocked: () => boolean,
		private run: (ctx: ExtensionContext, isCurrent: () => boolean) => Promise<void>,
		private time: ExpiryClock = clock,
	) {}

	private refreshSettings(): void { this.settings = readExpirySettings(this.pi.getSettings()); }

	stop(reason: string): void {
		if (this.timer !== undefined) this.time.clearTimeout(this.timer);
		this.timer = undefined;
		const ui = this.owner?.ui;
		this.owner = undefined;
		this.reason = reason;
		// Bare SDK dispose invalidates the context before resource cleanup.
		try { ui?.setStatus(STATUS_KEY, undefined); } catch { /* UI already disposed */ }
	}

	reset(): void {
		this.stop("session reset");
		this.attempted.clear();
	}

	start(ctx: ExtensionContext): void {
		this.stop("idle boundary");
		this.refreshSettings();
		const owner = { context: ctx, ui: ctx.ui, session: ctx.sessionManager.getSessionId(), model: modelKey(ctx) };
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

	private eligibility(ctx: ExtensionContext, state: CacheState | undefined, attempted = true): string | undefined {
		if (!this.settings.compactBeforeExpiry) return "pre-expiry compaction disabled";
		if (!this.settings.compactionEnabled) return "compaction.enabled is false";
		if (!state) return "companion unavailable";
		if (!state.available) return state.reason;
		if (state.expiresAt === undefined) return "cache TTL unknown";
		if (state.expiresAt <= this.time.now()) return "estimated TTL expired";
		if (state.cachedTokens <= 0) return "no cached usage";
		const tokens = ctx.getContextUsage()?.tokens;
		const actual = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : state.inputTokens;
		if (actual < this.settings.minContextTokens) return "below minContextTokens";
		if (attempted && this.attempted.has(state.cycle)) return "cycle already attempted";
		return undefined;
	}

	private tick(owner: IdleOwner): void {
		if (!this.current(owner)) return;
		const ctx = owner.context;
		if (!this.canRun(owner)) {
			this.reason = "busy or pending work";
			ctx.ui.setStatus(STATUS_KEY, undefined);
			this.schedule(owner);
			return;
		}
		this.refreshSettings();
		const state = readCacheState(this.pi, ctx);
		ctx.ui.setStatus(STATUS_KEY, this.settings.cacheStatus ? cacheLabel(state, this.time.now()) : undefined);
		const reason = this.eligibility(ctx, state);
		if (reason) {
			this.reason = reason;
			if (this.settings.cacheStatus || (this.settings.compactBeforeExpiry && this.settings.compactionEnabled)) this.schedule(owner);
			return;
		}
		const delay = state!.expiresAt! - this.time.now() - this.settings.leadTimeSeconds * 1_000;
		if (delay > 0) {
			this.reason = "waiting for estimated expiry lead time";
			this.schedule(owner, Math.min(REFRESH_MS, delay));
			return;
		}
		// Consume before emitting: failed, declined, and missing listeners must not
		// retry this cycle. Only a successful newer request/warm grants another try.
		this.attempted.add(state!.cycle);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		this.reason = "requesting cached-only compaction";
		void this.fire(owner, state!).catch(() => {
			// No request/error text: provider failures can contain private payloads.
			if (this.current(owner)) {
				this.reason = "pre-expiry compaction failed";
				this.schedule(owner);
			}
		});
	}

	private async fire(owner: IdleOwner, state: CacheState): Promise<void> {
		let result: Promise<boolean> | undefined;
		let ran = false;
		let invoked = false;
		let responding = true;
		this.pi.events.emit("pi-provider-compaction:compact-before-expiry", {
			context: owner.context,
			cycle: state.cycle,
			run: async () => {
				// A companion may await preparation before running. Recheck both our
				// ownership and its current cycle/TTL immediately before ctx.compact.
				if (invoked) return;
				invoked = true;
				// respond() must happen synchronously, even if run() was called while
				// evaluating its promise argument. No response means no authorization.
				await Promise.resolve();
				if (!result || !this.canRun(owner)) return;
				this.refreshSettings();
				const fresh = readCacheState(this.pi, owner.context);
				if (fresh?.cycle !== state.cycle || this.eligibility(owner.context, fresh, false)) return;
				ran = true;
				await this.run(owner.context, () => this.current(owner));
			},
			respond: (promise: Promise<boolean>) => {
				const safe = Promise.resolve(promise);
				// Drain even a rejected duplicate/late response without detaching it.
				void safe.catch(() => {});
				if (responding && !result) result = safe;
			},
		});
		responding = false;
		const accepted = result ? await result : false;
		if (!this.current(owner)) return;
		this.reason = accepted && ran ? "pre-expiry compaction completed" : "companion declined or compaction failed";
		this.schedule(owner);
	}

	hint(ctx: ExtensionContext): string {
		this.refreshSettings();
		if (!this.settings.cacheStatus) return "";
		const state = readCacheState(this.pi, ctx);
		// Don't expand every context hint when the companion is absent.
		return state ? `; ${cacheLabel(state, this.time.now())}` : "";
	}

	status(ctx: ExtensionContext): string {
		this.refreshSettings();
		const state = readCacheState(this.pi, ctx);
		return [
			`compactor: ${JSON.stringify(this.settings)}`,
			`Cache: ${cacheLabel(state, this.time.now())}; ${state?.reason ?? "companion unavailable"}`,
			`Last scheduling reason: ${this.reason}`,
		].join("\n");
	}
}
