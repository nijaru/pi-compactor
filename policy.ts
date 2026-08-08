import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const PROJECT_POLICY = "compaction-policy.json";
const AGENT_DIR_OVERRIDE = "PI_COMPACTOR_AGENT_DIR";
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_MODEL_SELECTORS = 8;
const MAX_SELECTOR_LENGTH = 512;

// Start compaction before Pi's hard reserve is reached, but only at a settled
// agent boundary. This leaves room for a long response without interrupting
// tools or racing provider requests.
const AUTO_COMPACT_RATIO = 0.7;

// ── Context hint thresholds ─────────────────────────────────────────────
// ≤128k: 50% (hardware-constrained windows, model handles full context fine)
// >128k: 128k tokens (quality degradation zone, proactive before 200k price cliff)
export function hintPercent(window: number): number {
	if (!Number.isFinite(window) || window <= 0) return 50;
	if (window <= 128_000) return 50;
	return Math.max(1, Math.round((128_000 / window) * 100));
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

export interface ContextUsageLike {
	tokens: number | null;
	percent: number | null;
	contextWindow: number;
}

/**
 * Mark automatic compaction once usage reaches the source-level safety ratio.
 * The caller starts it only after agent_settled, never during active tools.
 */
export function shouldAutoCompact(usage: ContextUsageLike): boolean {
	if (!Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return false;
	if (usage.tokens !== null && Number.isFinite(usage.tokens)) {
		return usage.tokens >= usage.contextWindow * AUTO_COMPACT_RATIO;
	}
	return usage.percent !== null && Number.isFinite(usage.percent) && usage.percent >= AUTO_COMPACT_RATIO * 100;
}

/**
 * Trigger: percent or the absolute token floor reaches the hint threshold.
 * Throttle: skip when both deltas are below their thresholds.
 *
 * 128k → first at 64k (50%), then ~72k, 80k… (percent delta ~6k dominates)
 * 1m   → first at 128k (13%), then ~153k, 178k… (token delta ~25k dominates)
 */
export function shouldInject(
	usage: ContextUsageLike,
	last: { percent: number; tokens: number },
): boolean {
	const percent = usage.percent ?? 0;
	const tokens = usage.tokens ?? 0;
	const window = usage.contextWindow;
	if (!Number.isFinite(window) || window <= 0) return false;

	const minimumTokens = window <= 128_000 ? window * 0.5 : 128_000;
	const tokensKnown = usage.tokens !== null && Number.isFinite(tokens);
	const percentKnown = usage.percent !== null && Number.isFinite(percent);
	const reachedThreshold = tokensKnown
		? tokens >= minimumTokens
		: percentKnown && percent >= hintPercent(window);

	if (!reachedThreshold) return false;
	// The first eligible hint must not be blocked by the later token-delta throttle.
	if (last.tokens === 0 && last.percent === 0) return true;

	// A model switch, tree navigation, or an unannounced context reset can lower
	// usage without emitting one of the session events that normally resets state.
	const usageRegressed =
		(usage.tokens !== null && tokens < last.tokens) ||
		(usage.percent !== null && percent < last.percent);
	if (usageRegressed) return true;

	const percentDelta = 5;
	const tokenDelta = Math.max(10_000, Math.round(Math.max(0, window) * 0.025));
	return percent - last.percent >= percentDelta || tokens - last.tokens >= tokenDelta;
}

function normalizeSelector(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const selector = value.trim();
	if (selector.length === 0 || selector.length > MAX_SELECTOR_LENGTH) return undefined;
	return selector;
}

function parsePolicySelectors(value: unknown): string[] | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	if (!("models" in value) || !Array.isArray(value.models)) return undefined;

	const selectors: string[] = [];
	for (const model of value.models) {
		const selector = normalizeSelector(model);
		if (selector === undefined || selectors.includes(selector)) continue;
		selectors.push(selector);
		if (selectors.length === MAX_MODEL_SELECTORS) break;
	}
	return selectors;
}

function readPolicySelectors(configPath: string): string[] | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(configPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_POLICY_BYTES) return undefined;

		// Read a bounded amount from the opened regular file. This avoids both
		// FIFO blocking and a stat/read TOCTOU defeating the size limit.
		const buffer = Buffer.allocUnsafe(MAX_POLICY_BYTES + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
			if (count === 0) break;
			bytesRead += count;
		}
		if (bytesRead > MAX_POLICY_BYTES) return undefined;
		return parsePolicySelectors(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown);
	} catch {
		// A malformed or unreadable policy must not prevent pi's default compaction.
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// The policy is optional; a close failure must not break compaction.
			}
		}
	}
}

type PolicyContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted"> & {
	sessionManager?: Pick<ExtensionContext["sessionManager"], "getSessionDir">;
};

function activeAgentDir(ctx: PolicyContext): string {
	const override = process.env[AGENT_DIR_OVERRIDE]?.trim();
	if (override) return resolve(override);

	try {
		const sessionDir = ctx.sessionManager?.getSessionDir();
		if (sessionDir) {
			const resolvedCwd = resolve(ctx.cwd);
			const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const suffix = `${sep}${join("sessions", safePath)}`;
			const resolvedSessionDir = resolve(sessionDir);
			if (resolvedSessionDir.endsWith(suffix)) {
				return resolvedSessionDir.slice(0, -suffix.length);
			}
		}
	} catch {
		// Fall back to Pi's configured directory when the SDK session is custom.
	}
	return getAgentDir();
}

function isProjectPolicyTrusted(ctx: PolicyContext, agentDir: string): boolean {
	try {
		if (!ctx.isProjectTrusted()) return false;
		// Pi does not treat this custom filename as a trust-requiring resource.
		// Also accept an explicit saved trust decision for policy-only projects.
		return hasTrustRequiringProjectResources(ctx.cwd) || new ProjectTrustStore(agentDir).get(ctx.cwd) === true;
	} catch {
		return false;
	}
}

/** Read model selectors from flag, then trusted project config, then global config. */
export function readModelSelectors(pi: Pick<ExtensionAPI, "getFlag">, ctx: PolicyContext): string[] {
	const rawFlag = pi.getFlag("compaction-model");
	if (typeof rawFlag === "string" && rawFlag.trim()) {
		const flag = normalizeSelector(rawFlag);
		return flag ? [flag] : [];
	}

	const agentDir = activeAgentDir(ctx);
	const configPaths = [join(agentDir, "compaction-policy.json")];
	if (isProjectPolicyTrusted(ctx, agentDir)) configPaths.unshift(join(ctx.cwd, CONFIG_DIR_NAME, PROJECT_POLICY));

	for (const configPath of configPaths) {
		const selectors = readPolicySelectors(configPath);
		if (selectors !== undefined) return selectors;
	}
	return [];
}

export function safeForLog(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
		.replace(/(authorization|api[-_ ]?key|token|secret|password)(?:\s+\w+){0,3}\s*[:=]\s*(?:bearer\s+)?\S+/gi, "$1=[redacted]")
		.replace(/([?&](?:api[-_ ]?key|key|token|secret|password)=)[^&\s]+/gi, "$1[redacted]")
		.replace(/bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\b(?:sk|rk|xai)-[A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
		.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
		.slice(0, 160);
}

function errorStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	for (const key of ["status", "statusCode"]) {
		const value = (error as Record<string, unknown>)[key];
		if (typeof value === "number") return value;
	}
	return undefined;
}

export function errorSummary(error: unknown): string {
	const status = errorStatus(error);
	if (status !== undefined) return `HTTP ${status}`;
	if (error instanceof Error) return safeForLog(error.message || error.name || "provider error");
	return safeForLog(String(error));
}

export function isTransientError(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") return false;
	const message = error instanceof Error ? error.message : String(error);
	if (/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|usage[_ ]limit[_ ]reached|usage[_ ]not[_ ]included|available balance|insufficient[_ ]quota|out of budget|quota exceeded|billing|payment required/i.test(message)) {
		return false;
	}

	const status = errorStatus(error);
	if (status !== undefined) return status === 408 || status === 425 || status === 429 || status >= 500;

	return /overloaded|rate.?limit|too many requests|(?:^|\D)(?:408|425|429|500|502|503|504|524)(?:\D|$)|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|connection.?reset|fetch failed|upstream.?connect|socket hang up|timed.?out|timeout|econnreset|econnrefused/i.test(
		message,
	);
}

export function isUsableCompactionResult(result: unknown): result is { summary: string } {
	return (
		typeof result === "object" &&
		result !== null &&
		"summary" in result &&
		typeof (result as { summary?: unknown }).summary === "string" &&
		(result as { summary: string }).summary.trim().length > 0
	);
}
