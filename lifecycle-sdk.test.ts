import { expect, test } from "bun:test";
import { InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "./index";

async function fixture(extra?: ExtensionFactory, { extraFirst = false, configuredModel = true } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-compactor-lifecycle-sdk-"));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: extra ? (extraFirst ? [extra, register] : [register, extra]) : [register],
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	if (configuredModel) resourceLoader.getExtensions().runtime.flagValues.set("compaction-model", "faux/faux-1");
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false,
	});
	const faux = fauxProvider();
	modelRuntime.registerNativeProvider(faux.provider);
	const { session } = await createAgentSession({
		cwd: directory, agentDir: directory, model: faux.getModel(), modelRuntime, settingsManager,
		sessionManager: SessionManager.inMemory(directory), resourceLoader, noTools: "builtin",
	});
	const errors: unknown[] = [];
	await session.bindExtensions({ onError: error => errors.push(error) });
	return { session, faux, errors, cleanup: async () => { session.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test.each([
	{ continueAfterCompaction: true, configuredModel: true },
	{ continueAfterCompaction: false, configuredModel: true },
	{ continueAfterCompaction: true, configuredModel: false },
])("SDK compaction preserves continuation intent: %j", async ({ continueAfterCompaction, configuredModel }) => {
	const preparations: Array<string | undefined> = [];
	const f = await fixture(pi => {
		pi.on("session_before_compact", event => { preparations.push(event.customInstructions); });
	}, { configuredModel });
	try {
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("compact", { continueAfterCompaction }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Preserved task state."),
			fauxAssistantMessage("Final continuation completed."),
		]);
		await f.session.prompt("Finish the task and compact.");
		// Check prompt() itself before waitForIdle can mask an early return.
		expect(f.session.sessionManager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(f.session.isCompacting).toBe(false);
		const resumes = f.session.messages.filter(message => message.role === "custom" && message.customType === "pi-compactor-resume");
		expect(resumes).toHaveLength(continueAfterCompaction ? 1 : 0);
		expect(preparations).toHaveLength(1);
		if (continueAfterCompaction) {
			expect(preparations[0]).toContain("Preserve the active user request");
			expect(preparations[0]).toContain("pending implementation, verification, or delivery");
			expect(resumes[0]).toMatchObject({ display: false, content: expect.stringContaining("a recap or handoff does not finish that work") });
			expect(f.session.getLastAssistantText()).toBe("Final continuation completed.");
		} else {
			expect(preparations[0]).toBeUndefined();
		}
		expect(f.faux.state.callCount).toBe(continueAfterCompaction ? 3 : 2);
		expect(f.errors).toEqual([]);
		await f.session.waitForIdle();
		// SDK consumers dispose immediately after prompt; no detached work may
		// subsequently touch the invalidated context or start a late turn.
		f.session.dispose();
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(f.errors).toEqual([]);
	} finally { await f.cleanup(); }
});

test.each(["run", "compaction"])("SDK cancellation of %s does not dispatch a continuation", async stage => {
	const f = await fixture(pi => {
		if (stage === "run") {
			pi.on("tool_result", (event, ctx) => { if (event.toolName === "compact") ctx.abort(); });
		} else {
			pi.on("session_before_compact", () => ({ cancel: true }));
		}
	});
	try {
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("compact", { continueAfterCompaction: true }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Preserved task state."),
		]);
		await f.session.prompt("Finish the task and compact.");
		await f.session.waitForIdle();
		expect(f.session.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
		expect(f.session.messages.some(message => message.role === "custom" && message.customType === "pi-compactor-resume")).toBe(false);
		expect(f.faux.state.callCount).toBe(stage === "run" ? 1 : 2);
		expect(f.session.isCompacting).toBe(false);
		expect(f.errors).toEqual([]);
	} finally { await f.cleanup(); }
});

// Startup is busy both before and after our acknowledgement handler. A slow
// hook must neither detach prompt completion nor cause a duplicate dispatch.
test.each([true, false])("SDK awaits busy startup hooks registered before compactor (%s)", async extraFirst => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let started!: () => void;
	const startup = new Promise<void>(resolve => { started = resolve; });
	let customStarts = 0;
	const f = await fixture(pi => {
		pi.on("before_agent_start", async (event, ctx) => {
			if (event.messageType !== "custom") return;
			customStarts++;
			expect(ctx.isIdle()).toBe(false);
			started();
			await gate;
		});
	}, { extraFirst });
	let prompt: Promise<void> | undefined;
	try {
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("compact", { continueAfterCompaction: true }), { stopReason: "toolUse" }),
			fauxAssistantMessage("First summary."),
			fauxAssistantMessage(fauxToolCall("compact", { continueAfterCompaction: false }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Second summary."),
			// The resumed custom-message turn can be split at the retention cut.
			fauxAssistantMessage("Preserved resumed turn prefix."),
		]);
		let finished = false;
		prompt = f.session.prompt("Compact, continue, then compact without continuing.").then(() => { finished = true; });
		await startup;
		expect(finished).toBe(false);
		release();
		await prompt;
		await f.session.waitForIdle();
		expect(customStarts).toBe(1);
		expect(f.session.sessionManager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(2);
		// Compaction may remove the recovery message from active model context;
		// the persisted branch still proves there was exactly one dispatch.
		expect(f.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "pi-compactor-resume")).toHaveLength(1);
		expect(f.faux.state.callCount).toBe(5);
		expect(f.errors).toEqual([]);
	} finally {
		release();
		await prompt;
		await f.cleanup();
	}
});
