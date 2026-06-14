import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";

const GLOBAL_CONFIG = join(homedir(), ".pi", "agent", "compaction-policy.json");
const PROJECT_CONFIG = ".pi/compaction-policy.json";

/** Default thresholds for context usage alerts. */
const DEFAULT_PERCENT_THRESHOLD = 50;
/**
 * Token threshold scales with context window (25%, floor 100k, cap 200k).
 * Catches large windows early — reasoning degrades well before max context,
 * and some providers increase pricing above 200k tokens.
 *
 *   128k → 100k (floor)
 *   200k → 100k (floor)
 *   1m   → 200k (cap)
 */
const TOKEN_THRESHOLD_FLOOR = 100_000;
const TOKEN_THRESHOLD_CAP = 200_000;
const TOKEN_THRESHOLD_RATIO = 0.25;

interface ThrottleState {
	lastInjectedPercent: number;
	lastInjectedTokens: number;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

/**
 * Should we inject a context hint?
 *
 * Trigger: OR logic — fires when EITHER threshold is crossed:
 * - 50% of context window (catches small-medium windows)
 * - 25% of window, floor 100k, cap 200k (catches large windows early)
 *
 * Throttle: AND logic — skips only when BOTH deltas are below:
 * - 5 percentage points for percent delta
 * - 2.5% of window for token delta (floor 10k)
 *
 * Examples:
 *   128k → first at 64k (50%), then ~72k, 80k, 88k… (percent delta ~6k dominates)
 *   200k → first at 100k (50%), then ~110k, 120k… (both ~10k)
 *   1m   → first at 200k (token cap), then ~225k, 250k… (token delta ~25k dominates)
 */
function shouldInject(
	usage: { tokens: number | null; percent: number | null; contextWindow: number },
	last: ThrottleState,
): boolean {
	const percent = usage.percent ?? 0;
	const tokens = usage.tokens ?? 0;
	const window = usage.contextWindow;

	// Dynamic thresholds
	const tokenThreshold = Math.min(TOKEN_THRESHOLD_CAP, Math.max(TOKEN_THRESHOLD_FLOOR, Math.round(window * TOKEN_THRESHOLD_RATIO)));

	// Must cross at least one threshold
	if (percent < DEFAULT_PERCENT_THRESHOLD && tokens < tokenThreshold) return false;

	// Throttle deltas scale with window size
	const percentDelta = 5;
	const tokenDelta = Math.max(10_000, Math.round(window * 0.025));

	if (percent - last.lastInjectedPercent < percentDelta &&
		tokens - last.lastInjectedTokens < tokenDelta) {
		return false;
	}

	return true;
}

export default function (pi: ExtensionAPI) {
	// ── Context usage awareness ──────────────────────────────────────────
	const throttle: ThrottleState = { lastInjectedPercent: 0, lastInjectedTokens: 0 };

	pi.on("context", (event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage) return;

		if (!shouldInject(usage, throttle)) return;

		const percent = usage.percent ?? 0;
		const tokens = usage.tokens ?? 0;
		const window = usage.contextWindow;

		throttle.lastInjectedPercent = percent;
		throttle.lastInjectedTokens = tokens;

		const urgency = percent >= 80 || tokens >= window * 0.8
			? "Approaching context limit."
			: "";

		event.messages.push({
			role: "user",
			content: `[Context: ${formatTokens(tokens)}/${formatTokens(window)} (${percent}%)]${urgency ? " " + urgency : ""} Consider compacting if at a natural stopping point.`,
			timestamp: Date.now(),
		} as any);
	});

	// ── Compaction model ────────────────────────────────────────────────
	pi.registerFlag("compaction-model", {
		description: "Model for compaction summaries (provider/model-id, e.g. openrouter/deepseek/deepseek-v4-flash)",
		type: "string",
	});

	function readConfigModel(configPath: string): string | undefined {
		try {
			if (!existsSync(configPath)) return undefined;
			const json = JSON.parse(readFileSync(configPath, "utf8"));
			if (Array.isArray(json.models) && typeof json.models[0] === "string") return json.models[0];
		} catch {
			// ignore malformed config
		}
		return undefined;
	}

	function readModelSelector(): string | undefined {
		const flag = pi.getFlag("compaction-model") as string | undefined;
		if (flag) return flag;
		return readConfigModel(PROJECT_CONFIG) ?? readConfigModel(GLOBAL_CONFIG);
	}

	async function resolveCompactionModel(ctx: ExtensionContext) {
		const selector = readModelSelector();
		if (!selector) return undefined;

		const slash = selector.indexOf("/");
		if (slash === -1) {
			console.error(`[pi-compactor] invalid compaction-model format: "${selector}" (expected provider/model-id)`);
			return undefined;
		}

		const provider = selector.slice(0, slash);
		const modelId = selector.slice(slash + 1);

		try {
			const model = ctx.modelRegistry.find(provider, modelId);
			if (!model) {
				console.error(`[pi-compactor] compaction model not found: ${selector}`);
				return undefined;
			}
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				console.error(`[pi-compactor] compaction model auth failed: ${auth.error}`);
				return undefined;
			}
			return { model, apiKey: auth.apiKey, headers: auth.headers };
		} catch (err) {
			console.error(`[pi-compactor] failed to resolve compaction model:`, err);
			return undefined;
		}
	}

	pi.on("session_before_compact", async (event, ctx) => {
		const resolved = await resolveCompactionModel(ctx);
		if (!resolved) return undefined; // fall through to default compaction

		try {
			const result = await compact(
				event.preparation,
				resolved.model,
				resolved.apiKey,
				resolved.headers,
				event.customInstructions,
				event.signal,
			);
			return { compaction: result };
		} catch (err) {
			if (event.signal.aborted) return undefined;
			console.error(`[pi-compactor] compaction with ${resolved.model.name} failed, falling back to default:`, err);
			return undefined;
		}
	});

	const resetThrottle = () => {
		throttle.lastInjectedPercent = 0;
		throttle.lastInjectedTokens = 0;
	};

	// Track when the model triggers compaction via the tool
	let pendingCompactionContinue = false;

	// Reset throttle when context changes (compaction, session switch, tree navigation)
	pi.on("session_compact", () => {
		resetThrottle();
		if (pendingCompactionContinue) {
			pendingCompactionContinue = false;
			pi.sendUserMessage("Compaction complete. Review the summary and continue where you left off.", { deliverAs: "followUp" });
		}
	});
	pi.on("session_start", resetThrottle);
	pi.on("session_tree", resetThrottle);

	// ── Compact tool ─────────────────────────────────────────────────────
	pi.registerTool({
		name: "compact",
		label: "Compact",
		description: "Trigger context compaction to summarize older messages and free up context space.",
		promptSnippet: "Compact context at task boundaries to free up space",
		promptGuidelines: [
			"Use compact at natural task boundaries: after completing a feature, after research/exploration, before switching focus areas",
			"Use compact when tool results from file reads and commands are accumulating",
			"Provide instructions to preserve what matters: e.g., instructions='preserve API design decisions'",
			"After compacting, re-read files you were actively editing",
			"Do NOT compact mid-task",
			"Do NOT retry if compaction fails (session too small or already compacted)",
		],
		parameters: Type.Object({
			instructions: Type.Optional(
				Type.String({
					description:
						"Focus instructions for the compaction summary (e.g., 'preserve API changes and error handling decisions')",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			pendingCompactionContinue = true;
			ctx.compact({
				customInstructions: params.instructions,
				onError: (error) => {
					pendingCompactionContinue = false;
					console.error("[pi-compactor] compaction failed:", error.message);
				},
			});
			return {
				content: [{ type: "text", text: "Compaction triggered. Will continue after session reload." }],
				details: {},
			};
		},
	});
}
