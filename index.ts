import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	errorSummary,
	formatTokens,
	hintPercent,
	isTransientError,
	isUsableCompactionResult,
	readModelSelectors,
	safeForLog,
	shouldInject,
} from "./policy";

export { errorSummary, formatTokens, hintPercent, isTransientError, isUsableCompactionResult, readModelSelectors, shouldInject } from "./policy";
export type { ContextUsageLike } from "./policy";

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_000;

type CompactionModel = Parameters<typeof compact>[1];
type ResolvedModel = {
	model: CompactionModel;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
};

function withoutDeletedHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	return Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== null)) as Record<string, string>;
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout>;
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(false);
		};
		timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

/** Resolve a single model selector to { model, apiKey, headers, env } via registry. */
async function resolveOne(selector: string, ctx: ExtensionContext): Promise<ResolvedModel | undefined> {
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) {
		console.error(`[pi-compactor] invalid model format: "${safeForLog(selector)}" (expected provider/model-id)`);
		return undefined;
	}

	const provider = selector.slice(0, slash).trim();
	const modelId = selector.slice(slash + 1).trim();
	if (!provider || !modelId) {
		console.error(`[pi-compactor] invalid model format: "${safeForLog(selector)}" (expected provider/model-id)`);
		return undefined;
	}

	try {
		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) {
			console.error(`[pi-compactor] model not found: ${safeForLog(selector)}`);
			return undefined;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			// Auth errors may contain command-backed credential configuration. Do not log them.
			console.error(`[pi-compactor] model auth failed for ${safeForLog(selector)}`);
			return undefined;
		}
		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		return {
			model: requestModel,
			apiKey: auth.apiKey,
			headers: withoutDeletedHeaders(auth.headers),
			env: auth.env,
		};
	} catch (error) {
		console.error(`[pi-compactor] failed to resolve ${safeForLog(selector)}: ${errorSummary(error)}`);
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const throttle = { percent: 0, tokens: 0, contextWindow: undefined as number | undefined };
	const resetThrottle = () => {
		throttle.percent = 0;
		throttle.tokens = 0;
		throttle.contextWindow = undefined;
	};
	type PendingCompaction = {
		id: number;
		generation: number;
		instructions?: string;
		phase: "awaiting-settlement" | "compacting";
	};
	type PendingResume = {
		message: string;
		generation: number;
	};
	let lifecycleGeneration = 0;
	let nextCompactionId = 1;
	let pendingCompaction: PendingCompaction | undefined;
	let pendingResume: PendingResume | undefined;
	let compactionTimer: ReturnType<typeof setTimeout> | undefined;
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;

	function clearCompactionTimer(): void {
		if (compactionTimer === undefined) return;
		clearTimeout(compactionTimer);
		compactionTimer = undefined;
	}

	function clearResumeTimer(): void {
		if (resumeTimer === undefined) return;
		clearTimeout(resumeTimer);
		resumeTimer = undefined;
	}

	function resetLifecycle(): void {
		lifecycleGeneration += 1;
		pendingCompaction = undefined;
		pendingResume = undefined;
		clearCompactionTimer();
		clearResumeTimer();
	}

	function sendResume(message: string): void {
		try {
			void Promise.resolve(pi.sendUserMessage(message)).catch((error) => {
				console.error(`[pi-compactor] failed to continue after compaction: ${errorSummary(error)}`);
			});
		} catch (error) {
			console.error(`[pi-compactor] failed to continue after compaction: ${errorSummary(error)}`);
		}
	}

	function flushPendingResume(ctx: ExtensionContext): void {
		const pending = pendingResume;
		if (!pending) return;
		if (pending.generation !== lifecycleGeneration) {
			pendingResume = undefined;
			return;
		}
		// Manual compaction aborts the active run. Do not put the recovery prompt
		// into that run's follow-up queue while lifecycle state is being rebuilt.
		if (!ctx.isIdle()) return;
		pendingResume = undefined;
		sendResume(pending.message);
	}

	function schedulePendingResume(ctx: ExtensionContext): void {
		if (resumeTimer !== undefined) return;
		resumeTimer = setTimeout(() => {
			resumeTimer = undefined;
			flushPendingResume(ctx);
		}, 0);
	}

	function queueResume(message: string, generation: number, ctx: ExtensionContext): void {
		if (generation !== lifecycleGeneration || pendingResume) return;
		pendingResume = { message, generation };
		schedulePendingResume(ctx);
	}

	function finishCompaction(
		id: number,
		generation: number,
		ctx: ExtensionContext,
		resumeMessage?: string,
	): void {
		const request = pendingCompaction;
		if (!request || request.id !== id || request.generation !== generation) return;
		pendingCompaction = undefined;
		clearCompactionTimer();
		if (resumeMessage) queueResume(resumeMessage, generation, ctx);
	}

	function scheduleCompaction(ctx: ExtensionContext): void {
		const request = pendingCompaction;
		if (!request || request.phase !== "awaiting-settlement" || compactionTimer !== undefined) return;
		const { id, generation } = request;
		compactionTimer = setTimeout(() => {
			compactionTimer = undefined;
			const current = pendingCompaction;
			if (
				!current ||
				current.id !== id ||
				current.generation !== generation ||
				current.phase !== "awaiting-settlement" ||
				generation !== lifecycleGeneration ||
				!ctx.isIdle()
			) {
				return;
			}

			current.phase = "compacting";
			const onComplete = () => finishCompaction(id, generation, ctx, "Continue.");
			const onError = (error: Error) => {
				const active = pendingCompaction;
				if (!active || active.id !== id || active.generation !== generation) return;
				if (/^already compacted$/i.test(error.message.trim())) {
					finishCompaction(id, generation, ctx, "Continue.");
					return;
				}
				console.error(`[pi-compactor] compaction failed: ${errorSummary(error)}`);
				if (error.name === "AbortError" || /cancelled/i.test(error.message)) {
					finishCompaction(id, generation, ctx);
					return;
				}
				finishCompaction(id, generation, ctx, `Compaction failed (${errorSummary(error)}). Continue without compaction.`);
			};

			try {
				ctx.compact({ customInstructions: current.instructions, onComplete, onError });
			} catch (error) {
				onError(error instanceof Error ? error : new Error(String(error)));
			}
		}, 0);
	}

	// ── Context usage awareness ──────────────────────────────────────────
	pi.on("context", (event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage) return;
		if (throttle.contextWindow !== undefined && throttle.contextWindow !== usage.contextWindow) resetThrottle();
		if (!shouldInject(usage, throttle)) return;

		const percent = usage.percent ?? 0;
		const tokens = usage.tokens ?? 0;
		const window = usage.contextWindow;

		throttle.percent = percent;
		throttle.tokens = tokens;
		throttle.contextWindow = window;

		// Usage data only. Labels like "context growing" prime reflexive
		// compaction; the number is the signal. [>200k] flags a cost tier.
		const marker = tokens >= 200_000 ? " [>200k]" : "";

		event.messages.push({
			role: "user",
			content: `[ctx ${formatTokens(tokens)}/${formatTokens(window)}]${marker}`,
			timestamp: Date.now(),
		});
	});

	// ── Compaction model ────────────────────────────────────────────────
	pi.registerFlag("compaction-model", {
		description: "Model for compaction summaries (provider/model-id, e.g. openrouter/deepseek/deepseek-v4-flash)",
		type: "string",
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// A deferred manual compaction starts only after Pi reports the terminating
		// agent run settled, which is later than tool-result persistence. Pi may
		// independently notice the same high context usage in the meantime; let the
		// explicit request own threshold compaction instead of racing it.
		if (event.reason === "threshold" && pendingCompaction) return { cancel: true };

		const selectors = readModelSelectors(pi, ctx);

		for (const selector of selectors) {
			for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
				// Resolve auth for every attempt so command-backed credentials and OAuth
				// tokens can refresh after a transient request failure.
				const resolved = await resolveOne(selector, ctx);
				if (!resolved) break;

				try {
					const provider = ctx.modelRegistry.getProvider(resolved.model.provider);
					if (!provider?.streamSimple) {
						console.error(`[pi-compactor] provider unavailable for ${safeForLog(selector)}; trying next model`);
						break;
					}

					// Use Pi's composed provider rather than @pi-ai/compat's global
					// dispatcher. This preserves extension providers, resolved endpoints,
					// and provider-specific request behavior for compaction calls.
					const result = await compact(
						event.preparation,
						resolved.model,
						resolved.apiKey,
						resolved.headers,
						event.customInstructions,
						event.signal,
						undefined,
						provider.streamSimple.bind(provider),
						resolved.env,
					);
					if (!isUsableCompactionResult(result)) {
						console.error(`[pi-compactor] ${safeForLog(selector)} returned an empty compaction summary`);
						break;
					}
					return { compaction: result };
				} catch (error) {
					if (event.signal.aborted || (error instanceof Error && error.name === "AbortError")) return undefined;
					if (!isTransientError(error) || attempt === MAX_ATTEMPTS) {
						console.error(`[pi-compactor] ${safeForLog(selector)} failed: ${errorSummary(error)}; trying next model`);
						break;
					}

					console.error(
						`[pi-compactor] ${safeForLog(selector)} transient failure (${errorSummary(error)}); retrying`,
					);
					if (!(await sleep(RETRY_DELAY_MS * attempt, event.signal))) return undefined;
				}
			}
		}
		// All models exhausted — fall back to pi default.
		return undefined;
	});

	// A saved compaction is authoritative even when another extension or /compact
	// won the race. Reconcile it before ctx.compact's callback so an abandoned
	// callback cannot leave the tool permanently in flight or resume twice.
	pi.on("session_compact", (_event, ctx) => {
		resetThrottle();
		const request = pendingCompaction;
		if (request) finishCompaction(request.id, request.generation, ctx, "Continue.");
	});
	pi.on("agent_settled", (_event, ctx) => {
		// ctx.compact aborts an active operation. Starting it from the compact tool
		// (even on a zero-delay timer) can race tool-result persistence and turn
		// accounting. agent_settled is the first lifecycle event that guarantees no
		// retry or follow-up remains.
		if (pendingCompaction?.phase === "awaiting-settlement") scheduleCompaction(ctx);
		if (pendingResume) schedulePendingResume(ctx);
	});
	pi.on("session_start", () => {
		resetThrottle();
		resetLifecycle();
	});
	pi.on("session_tree", () => {
		resetThrottle();
		resetLifecycle();
	});
	pi.on("model_select", resetThrottle);
	pi.on("session_shutdown", () => {
		resetThrottle();
		resetLifecycle();
	});

	// ── Compact tool ─────────────────────────────────────────────────────
	pi.registerTool({
		name: "compact",
		label: "Compact",
		description: "Trigger context compaction.",
		promptSnippet: "Compact context yourself at task boundaries",
		promptGuidelines: [
			"DEFER mid-task: If you have a clear next step in the current work — a file to write, a change to verify, a bug to finish fixing — do NOT compact. A [ctx] hint is informational, not a trigger. Keep working.",
			"Compact at genuine boundaries: the task is complete and verified, or you're switching to unrelated work. If no [ctx] hint has fired, you have room; don't bother.",
			"No user permission needed; this is your context management tool.",
			"Include instructions for what to preserve: current task, changed files, decisions, blockers, and next command.",
			"After compacting, re-read active files before continuing.",
		],
		parameters: Type.Object({
			instructions: Type.Optional(
				Type.String({
					description:
						"What to preserve in the summary (e.g., 'current task, changed files, decisions, blockers, next command')",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			if (pendingCompaction || pendingResume) {
				return {
					content: [{ type: "text", text: "Compaction is already in progress." }],
					details: {},
					isError: true,
				};
			}

			pendingCompaction = {
				id: nextCompactionId++,
				generation: lifecycleGeneration,
				instructions: params.instructions,
				phase: "awaiting-settlement",
			};

			return {
				content: [{ type: "text", text: "Compaction started. The result will be reported when it finishes." }],
				details: {},
				terminate: true,
			};
		},
	});
}
