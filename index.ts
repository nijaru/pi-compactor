import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";

const GLOBAL_CONFIG = join(homedir(), ".pi", "agent", "compaction-policy.json");
const PROJECT_CONFIG = ".pi/compaction-policy.json";

// ── Context hint thresholds ─────────────────────────────────────────────
// ≤128k: 50% (hardware-constrained windows, model handles full context fine)
// >128k: 128k tokens (quality degradation zone, proactive before 200k price cliff)
function hintPercent(window: number): number {
	return Math.min(50, Math.round(128_000 / window * 100));
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

/**
 * Trigger: percent >= hintPercent(window).
 * Throttle: skip when BOTH deltas are below threshold.
 *
 * 128k → first at 64k (50%), then ~72k, 80k… (percent delta ~6k dominates)
 * 1m   → first at 128k (13%), then ~153k, 178k… (token delta ~25k dominates)
 */
function shouldInject(
	usage: { tokens: number | null; percent: number | null; contextWindow: number },
	last: { percent: number; tokens: number },
): boolean {
	const percent = usage.percent ?? 0;
	const tokens = usage.tokens ?? 0;
	const window = usage.contextWindow;

	if (percent < hintPercent(window)) return false;

	const percentDelta = 5;
	const tokenDelta = Math.max(10_000, Math.round(window * 0.025));
	return percent - last.percent >= percentDelta || tokens - last.tokens >= tokenDelta;
}

/** Read model selectors from flag, then project config, then global config. Returns ordered list for fallback chain. */
function readModelSelectors(pi: ExtensionAPI): string[] {
	const flag = pi.getFlag("compaction-model") as string | undefined;
	if (flag) return [flag];

	for (const configPath of [PROJECT_CONFIG, GLOBAL_CONFIG]) {
		try {
			if (!existsSync(configPath)) continue;
			const json = JSON.parse(readFileSync(configPath, "utf8"));
			if (Array.isArray(json.models)) return json.models.filter((m: unknown) => typeof m === "string");
		} catch {
			// ignore malformed config
		}
	}
	return [];
}

type ResolvedModel = { model: any; apiKey: string; headers: Record<string, string> };

/** Resolve a single model selector to { model, apiKey, headers } via registry. */
async function resolveOne(selector: string, ctx: ExtensionContext): Promise<ResolvedModel | undefined> {
	const slash = selector.indexOf("/");
	if (slash === -1) {
		console.error(`[pi-compactor] invalid model format: "${selector}" (expected provider/model-id)`);
		return undefined;
	}

	const provider = selector.slice(0, slash);
	const modelId = selector.slice(slash + 1);

	try {
		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) {
			console.error(`[pi-compactor] model not found: ${selector}`);
			return undefined;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			console.error(`[pi-compactor] model auth failed for ${selector}: ${auth.error}`);
			return undefined;
		}
		return { model, apiKey: auth.apiKey!, headers: auth.headers! };
	} catch (err) {
		console.error(`[pi-compactor] failed to resolve ${selector}:`, err);
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const throttle = { percent: 0, tokens: 0 };
	const resetThrottle = () => { throttle.percent = 0; throttle.tokens = 0; };

	// ── Context usage awareness ──────────────────────────────────────────
	pi.on("context", (event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || !shouldInject(usage, throttle)) return;

		const percent = usage.percent ?? 0;
		const tokens = usage.tokens ?? 0;
		const window = usage.contextWindow;

		throttle.percent = percent;
		throttle.tokens = tokens;

		const priceCliff = tokens >= 200_000;
		const escalate = percent >= 80 || tokens >= 200_000;
		const tag = priceCliff ? " [! >200k]" : "";
		const action = escalate ? "compact soon" : "context growing";

		event.messages.push({
			role: "user",
			content: `[ctx ${formatTokens(tokens)}/${formatTokens(window)} ${percent}%]${tag} ${action}`,
			timestamp: Date.now(),
		} as any);
	});

	// ── Compaction model ────────────────────────────────────────────────
	pi.registerFlag("compaction-model", {
		description: "Model for compaction summaries (provider/model-id, e.g. openrouter/deepseek/deepseek-v4-flash)",
		type: "string",
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const selectors = readModelSelectors(pi);
		const maxAttempts = 2; // retry each model once on transient failure

		for (const selector of selectors) {
			const resolved = await resolveOne(selector, ctx);
			if (!resolved) continue;

			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
					if (attempt < maxAttempts) {
						await new Promise(r => setTimeout(r, 1000 * attempt));
						continue;
					}
					console.error(`[pi-compactor] ${selector} failed after ${maxAttempts} attempts, trying next model`);
				}
			}
		}
		// all models exhausted — fall back to pi default
		return undefined;
	});

	// Reset throttle on context changes
	pi.on("session_compact", resetThrottle);
	pi.on("session_start", resetThrottle);
	pi.on("session_tree", resetThrottle);

	// ── Compact tool ─────────────────────────────────────────────────────
	pi.registerTool({
		name: "compact",
		label: "Compact",
		description: "Compact context by summarizing older messages to free space.",
		promptSnippet: "Compact at task boundaries when context is substantial",
		promptGuidelines: [
			"At a genuine boundary — the task you were given is complete and verified, or you're switching to unrelated work — compact once context hints are firing. If no hints have fired, you have room; don't bother.",
			"Mid-task — you know what you're doing next and it's part of the same effort — don't compact on 'context growing' hints; that's awareness, not a trigger. Only compact if hints escalate to 'compact soon' or '! >200k', preserving active state in your instructions.",
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ctx.compact({
				customInstructions: params.instructions,
				onComplete: () => setTimeout(() => pi.sendUserMessage("Continue."), 0),
				onError: (error) => console.error("[pi-compactor] compaction failed:", error.message),
			});
			return {
				content: [{ type: "text", text: "Compaction triggered. Will continue after session reload." }],
				details: {},
			};
		},
	});
}
