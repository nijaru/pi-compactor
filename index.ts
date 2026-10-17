import { randomUUID } from "node:crypto";
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
const RESUME_CUSTOM_TYPE = "pi-compactor-resume";
const RESUME_MESSAGE = "Resume only unfinished work; if none remains, give the final response and stop.";
const RESUME_AFTER_FAILURE_MESSAGE =
	"Compaction failed; resume only unfinished work without compaction, then give the final response.";

type CompactionModel = Parameters<typeof compact>[1];
type ResolvedModel = {
	model: CompactionModel;
	apiKey?: string;
	// Pi's ProviderHeaders carry `null` to delete a provider default; keep them so a
	// configured deletion still applies to the summary request.
	headers?: Record<string, string | null>;
	env?: Record<string, string>;
};

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
			headers: auth.headers,
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
	type PendingResume = { id: string };
	let pendingCompaction: PendingCompaction | undefined;
	let pendingResume: PendingResume | undefined;

	function resetLifecycle(): void {
		// Callback closures retain their request object. Clearing the reference
		// invalidates them without a separate generation counter.
		pendingCompaction = undefined;
		pendingResume = undefined;
	}

	function dispatchResume(message: string): void {
		const pending = { id: randomUUID() };
		pendingResume = pending;
		// Called within agent_settled: Pi queues this synchronously and awaits the
		// new run after all settled handlers finish. No delivery timeout is needed:
		// even slow settled/startup hooks remain owned by the original prompt().
		try {
			pi.sendMessage(
				{ customType: RESUME_CUSTOM_TYPE, content: message, display: false, details: { resumeId: pending.id } },
				{ triggerTurn: true },
			);
		} catch (error) {
			// sendMessage is fire-and-forget, but an inactive extension can still throw
			// synchronously. Do not leave the in-flight guard set for the rest of the
			// session when no resume turn can start.
			pendingResume = undefined;
			console.error(`[pi-compactor] failed to schedule resume: ${errorSummary(error)}`);
		}
	}

	async function runCompaction(request: PendingCompaction, ctx: ExtensionContext): Promise<void> {
		request.phase = "compacting";
		// ctx.compact is callback-based. Await its actual completion, not the
		// session_compact event (which fires before Pi clears compaction state).
		const error = await new Promise<Error | undefined>((resolve) => {
			try {
				ctx.compact({
					customInstructions: request.instructions,
					onComplete: () => resolve(undefined),
					onError: resolve,
				});
			} catch (error) {
				resolve(error instanceof Error ? error : new Error(String(error)));
			}
		});
		if (pendingCompaction !== request) return;
		let message = RESUME_MESSAGE;
		if (error && !/^already compacted$/i.test(error.message.trim())) {
			console.error(`[pi-compactor] compaction failed: ${errorSummary(error)}`);
			if (error.name === "AbortError" || /cancelled/i.test(error.message)) {
				pendingCompaction = undefined;
				return;
			}
			message = RESUME_AFTER_FAILURE_MESSAGE;
		}
		pendingCompaction = undefined;
		if (request.continueAfterCompaction) dispatchResume(message);
	}

	pi.on("before_agent_start", (event) => {
		if (event.messageType !== "custom" || event.message.customType !== RESUME_CUSTOM_TYPE) return;
		const resumeId = (event.message.details as { resumeId?: unknown } | undefined)?.resumeId;
		// Startup hooks run while busy; acknowledge by identity, not idle state.
		if (pendingResume && pendingResume.id === resumeId) pendingResume = undefined;
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

	// getFlag is scoped to the registering extension. Other compaction providers
	// must ask us for effective policy rather than reading our flag themselves.
	pi.events.on("pi-compactor:resolve-model-policy", (request) => {
		if (typeof request !== "object" || request === null) return;
		const { context, respond } = request as { context?: ExtensionContext; respond?: unknown };
		if (typeof respond !== "function" || typeof context !== "object" || context === null) return;
		if (typeof context.cwd !== "string" || typeof context.isProjectTrusted !== "function") return;
		respond(readModelSelectors(pi, context).length > 0);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// Claim only the first manual compaction event after ctx.compact starts.
		// A later manual event is a competing /compact request; cancel it rather
		// than letting two compactions mutate the session concurrently.
		if (event.reason === "manual" && pendingCompaction) {
			if (pendingCompaction.phase === "awaiting-settlement") {
				// A user /compact request won before the deferred tool request
				// started. Release the tool request so settlement cannot start a
				// second compaction while this one is summarizing.
				pendingCompaction = undefined;
			} else {
				if (pendingCompaction.owned) return { cancel: true };
				pendingCompaction.owned = true;
			}
		}
		// Pi owns automatic compaction and overflow recovery (including retries).
		// Release our request without adding another continuation. Let all handlers
		// observe it so behavior does not depend on extension registration order.
		if (event.reason === "threshold" || event.reason === "overflow") pendingCompaction = undefined;

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
					// `compact` narrows headers to strings, but Pi's provider pipeline reads
					// the same record and treats `null` as a deletion.
					const result = await compact(
						event.preparation,
						resolved.model,
						resolved.apiKey,
						resolved.headers as Record<string, string> | undefined,
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
	pi.on("session_compact", () => {
		resetThrottle();
		const request = pendingCompaction;
		// ctx.compact emits session_compact before its completion callback and while
		// Pi still rejects new prompts. The callback is the completion boundary for
		// our own request; a competing compaction has no such callback to wait for.
		if (request && !request.owned) {
			// A competing /compact or Pi compaction owns this saved result. Do not
			// emit the tool's recovery prompt for a compaction it did not start.
			pendingCompaction = undefined;
		}
	});
	pi.on("agent_settled", async (event, ctx) => {
		// A resume message clears this flag in before_agent_start. Anything still
		// pending here belongs to a delivery that never started, so clear it rather
		// than rejecting every later compact request.
		pendingResume = undefined;
		// A canceled run must not start deferred work. An already-started
		// ctx.compact owns its completion/error callback.
		if (event.aborted && pendingCompaction?.phase !== "compacting") {
			resetLifecycle();
			return;
		}
		// Pi marks the run idle before awaiting agent_settled handlers, so compact's
		// abort/waitForIdle cannot deadlock here (unlike agent_before_settle).
		// Keep prompt() awaiting compaction; synchronous sendMessage below enters
		// Pi's deferred-settled queue, whose continuation is also awaited by Pi.
		if (pendingCompaction?.phase === "awaiting-settlement" && ctx.isIdle()) {
			await runCompaction(pendingCompaction, ctx);
		}
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
				// Pi derives a tool error from a thrown error; a returned `isError` field is
				// ignored and would record the duplicate request as a successful result.
				throw new Error("Compaction is already in progress.");
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
