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

export {
	errorSummary,
	formatTokens,
	hintPercent,
	isTransientError,
	isUsableCompactionResult,
	readModelSelectors,
	shouldInject,
} from "./policy";
export type { ContextUsageLike } from "./policy";

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_000;
const MAX_RESUME_ATTEMPTS = 2;
const RESUME_ACK_TIMEOUT_MS = 5_000;
const RESUME_CUSTOM_TYPE = "pi-compactor-resume";
const RESUME_MESSAGE = "Resume only unfinished work; if none remains, give the final response and stop.";
const RESUME_AFTER_FAILURE_MESSAGE =
	"Compaction failed; resume only unfinished work without compaction, then give the final response.";

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
		instructions?: string;
		continueAfterCompaction: boolean;
		phase: "awaiting-settlement" | "compacting";
		owned?: boolean;
	};
	type PendingResume = { message: string; attempts: number };
	let pendingCompaction: PendingCompaction | undefined;
	let pendingResume: PendingResume | undefined;
	let activeResume: PendingResume | undefined;
	let resumeAckTimer: ReturnType<typeof setTimeout> | undefined;
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

	function clearResumeAckTimer(): void {
		if (resumeAckTimer === undefined) return;
		clearTimeout(resumeAckTimer);
		resumeAckTimer = undefined;
	}

	function resetLifecycle(): void {
		// Timer and callback closures retain their request object. Clearing the
		// reference invalidates them without a separate generation counter.
		pendingCompaction = undefined;
		pendingResume = undefined;
		activeResume = undefined;
		clearResumeAckTimer();
		clearCompactionTimer();
		clearResumeTimer();
	}

	function acknowledgeResume(pending: PendingResume): void {
		if (activeResume !== pending) return;
		activeResume = undefined;
		clearResumeAckTimer();
	}

	function failResume(pending: PendingResume, ctx: ExtensionContext, error: unknown): void {
		if (activeResume !== pending) return;
		activeResume = undefined;
		clearResumeAckTimer();
		console.error(`[pi-compactor] failed to continue after compaction: ${errorSummary(error)}`);
		if (pending.attempts >= MAX_RESUME_ATTEMPTS || pendingResume) return;
		pendingResume = pending;
		schedulePendingResume(ctx);
	}

	function sendResume(pending: PendingResume, ctx: ExtensionContext): void {
		pending.attempts += 1;
		activeResume = pending;
		try {
			// Keep the recovery instruction out of the visible user transcript while
			// still putting it in model context and starting a new turn.
			const dispatch = (pi.sendMessage as unknown as (
				message: { customType: string; content: string; display: boolean },
				options: { triggerTurn: boolean },
			) => unknown)(
				{
					customType: RESUME_CUSTOM_TYPE,
					content: pending.message,
					display: false,
				},
				{ triggerTurn: true },
			);
			if (dispatch !== undefined) {
				if (dispatch && typeof (dispatch as PromiseLike<unknown>).then === "function") {
					void Promise.resolve(dispatch).then(
						() => acknowledgeResume(pending),
						(error) => failResume(pending, ctx, error),
					);
				} else {
					acknowledgeResume(pending);
				}
				return;
			}
			// Pi has no acknowledgement for a void dispatch. The next agent_start
			// event confirms delivery; retry after a bounded delay if it never arrives.
			resumeAckTimer = setTimeout(() => {
				resumeAckTimer = undefined;
				failResume(pending, ctx, new Error("prompt dispatch was not acknowledged"));
			}, RESUME_ACK_TIMEOUT_MS);
		} catch (error) {
			failResume(pending, ctx, error);
		}
	}

	function flushPendingResume(pending: PendingResume, ctx: ExtensionContext): void {
		if (pendingResume !== pending) return;
		// Manual compaction aborts the active run. Do not put the recovery prompt
		// into that run's follow-up queue while lifecycle state is being rebuilt.
		if (!ctx.isIdle()) return;
		// Remove the pending marker before dispatch so the resumed run can request
		// another compaction without being rejected as a duplicate.
		pendingResume = undefined;
		sendResume(pending, ctx);
	}

	function schedulePendingResume(ctx: ExtensionContext): void {
		if (resumeTimer !== undefined) return;
		const pending = pendingResume;
		if (!pending) return;
		resumeTimer = setTimeout(() => {
			resumeTimer = undefined;
			flushPendingResume(pending, ctx);
		}, 0);
	}

	function queueResume(message: string, ctx: ExtensionContext): void {
		if (pendingResume) return;
		pendingResume = { message, attempts: 0 };
		schedulePendingResume(ctx);
	}

	function finishCompaction(
		request: PendingCompaction,
		ctx: ExtensionContext,
		resumeMessage?: string,
	): void {
		if (pendingCompaction !== request) return;
		pendingCompaction = undefined;
		clearCompactionTimer();
		if (resumeMessage) queueResume(resumeMessage, ctx);
	}

	function startCompaction(request: PendingCompaction, ctx: ExtensionContext): void {
		if (pendingCompaction !== request || request.phase !== "awaiting-settlement") return;
		request.phase = "compacting";
		const onComplete = () =>
			finishCompaction(request, ctx, request.continueAfterCompaction ? RESUME_MESSAGE : undefined);
		const onError = (error: Error) => {
			if (pendingCompaction !== request) return;
			if (/^already compacted$/i.test(error.message.trim())) {
				// Pi already performed the compaction; resume only when the tool call
				// explicitly said unfinished work remains.
				finishCompaction(request, ctx, request.continueAfterCompaction ? RESUME_MESSAGE : undefined);
				return;
			}
			console.error(`[pi-compactor] compaction failed: ${errorSummary(error)}`);
			if (error.name === "AbortError" || /cancelled/i.test(error.message)) {
				finishCompaction(request, ctx);
				return;
			}
			finishCompaction(
				request,
				ctx,
				request.continueAfterCompaction ? RESUME_AFTER_FAILURE_MESSAGE : undefined,
			);
		};

		try {
			ctx.compact({ customInstructions: request.instructions, onComplete, onError });
		} catch (error) {
			onError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	function scheduleCompaction(ctx: ExtensionContext): void {
		const request = pendingCompaction;
		if (!request || request.phase !== "awaiting-settlement" || compactionTimer !== undefined) return;
		compactionTimer = setTimeout(() => {
			compactionTimer = undefined;
			if (pendingCompaction !== request || request.phase !== "awaiting-settlement" || !ctx.isIdle()) return;
			startCompaction(request, ctx);
		}, 0);
	}

	pi.on("agent_start", () => {
		const pending = activeResume;
		if (pending) acknowledgeResume(pending);
	});

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
		const usageLabel = usage.tokens !== null && Number.isFinite(usage.tokens)
			? `${formatTokens(tokens)}/${formatTokens(window)}`
			: `?/${formatTokens(window)}${usage.percent !== null && Number.isFinite(percent) ? ` (${Math.round(percent)}%)` : ""}`;

		event.messages.push({
			role: "user",
			content: `[ctx ${usageLabel}]${marker}`,
			timestamp: Date.now(),
		});
	});

	// ── Compaction model ────────────────────────────────────────────────
	pi.registerFlag("compaction-model", {
		description: "Model for compaction summaries (provider/model-id, e.g. openrouter/deepseek/deepseek-v4-flash)",
		type: "string",
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// Claim only the first manual compaction event after ctx.compact starts.
		// A later manual event is a competing /compact request; cancel it rather
		// than letting two compactions mutate the session concurrently.
		if (event.reason === "manual" && pendingCompaction) {
			if (pendingCompaction.phase === "awaiting-settlement") {
				// A user /compact request won before the deferred tool request
				// started. Release the tool request immediately so its timer cannot
				// start a second compaction while this one is summarizing.
				finishCompaction(pendingCompaction, ctx);
			} else {
				if (pendingCompaction.owned) return { cancel: true };
				pendingCompaction.owned = true;
			}
		}
		// Pi's threshold compaction wins if it starts before our settled-boundary
		// request. Let all compaction handlers observe it; cancelling here would
		// make behavior depend on whether another extension ran before this one.
		if (event.reason === "threshold" && pendingCompaction) {
			finishCompaction(pendingCompaction, ctx);
		}
		// An overflow compaction can start before a deferred manual request. Do not
		// race it; Pi will retry the interrupted turn when willRetry is true.
		if (event.reason === "overflow" && pendingCompaction) {
			// Pi owns overflow recovery. It retries when willRetry is true; otherwise
			// the normal run settles without a compactor continuation.
			finishCompaction(pendingCompaction, ctx);
		}

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
	pi.on("session_compact", (event, ctx) => {
		resetThrottle();
		const request = pendingCompaction;
		// ctx.compact emits session_compact before its completion callback and while
		// Pi still rejects new prompts. The callback is the completion boundary for
		// our own request; a competing compaction has no such callback to wait for.
		if (request && !request.owned) {
			// A competing /compact or Pi compaction owns this saved result. Do not
			// emit the tool's recovery prompt for a compaction it did not start.
			finishCompaction(request, ctx);
		}
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
		description: "Trigger context compaction and choose whether a follow-up turn should run afterward.",
		promptSnippet: "Compact context yourself at task boundaries",
		promptGuidelines: [
			"DEFER mid-task: If you have a clear next step in the current work — a file to write, a change to verify, a bug to finish fixing — do NOT compact. A [ctx] hint is informational, not a trigger. Keep working.",
			"Compact at genuine boundaries: the task is complete and verified, or you're switching to unrelated work. If no [ctx] hint has fired, you have room; don't bother.",
			"Set continueAfterCompaction=true when unfinished work remains or a final response is still needed; set it false only when no follow-up turn should occur.",
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
			continueAfterCompaction: Type.Boolean({
				description: "Set true when unfinished work remains or a final response is needed; false only when no follow-up turn should occur.",
			}),
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
				instructions: params.instructions,
				continueAfterCompaction: params.continueAfterCompaction,
				phase: "awaiting-settlement",
			};

			return {
				content: [{
					type: "text",
					text: params.continueAfterCompaction
						? "Compaction scheduled; unfinished work will resume after it finishes."
						: "Compaction scheduled; no follow-up turn will be started.",
				}],
				details: {},
				terminate: true,
			};
		},
	});
}
