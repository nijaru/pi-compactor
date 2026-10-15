import { expect, test } from "bun:test";
import { InMemoryCredentialStore, InMemoryModelsStore, fauxProvider } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createEventBus,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "./index";

// A provider extension cannot read compactor's flag. The bus response must be
// synchronous and authoritative even when the effective policy is empty.
test.each([
	{ flag: undefined, models: [], expected: false },
	{ flag: undefined, models: ["summary/global"], expected: true },
	{ flag: "summary/flag", models: [], expected: true },
])("SDK resolves effective model policy: %j", async ({ flag, models, expected }) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-compactor-policy-sdk-"));
	let dispose: (() => void) | undefined;
	const previousAgentDir = process.env.PI_COMPACTOR_AGENT_DIR;
	process.env.PI_COMPACTOR_AGENT_DIR = directory;
	try {
		await writeFile(join(directory, "compaction-policy.json"), JSON.stringify({ models }));
		const events = createEventBus();
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
		let response: boolean | undefined;
		let foreignFlag: unknown;
		let responseCount = 0;
		const resourceLoader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager,
			eventBus: events,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				register,
				(pi) => {
					pi.on("session_start", (_event, context) => {
						foreignFlag = pi.getFlag("compaction-model");
						pi.events.emit("pi-compactor:resolve-model-policy", {
							context,
							respond: (hasSelectors: boolean) => { response = hasSelectors; responseCount++; },
						});
						// Delayed answers would race provider selection.
						expect(response).toBe(expected);
					});
				},
			],
		});
		await resourceLoader.reload();
		const extensions = resourceLoader.getExtensions();
		expect(extensions.errors).toEqual([]);
		if (flag !== undefined) extensions.runtime.flagValues.set("compaction-model", flag);
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const faux = fauxProvider();
		modelRuntime.registerNativeProvider(faux.provider);
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			model: faux.getModel(),
			modelRuntime,
			settingsManager,
			sessionManager: SessionManager.inMemory(directory),
			resourceLoader,
			noTools: "builtin",
		});
		dispose = () => session.dispose();
		const errors: unknown[] = [];
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		expect(errors).toEqual([]);
		expect(foreignFlag).toBeUndefined();
		expect(response).toBe(expected);
		expect(responseCount).toBe(1);

		for (const malformed of [null, {}, { respond: () => { responseCount++; } }, { context: {}, respond: () => { responseCount++; } }]) {
			events.emit("pi-compactor:resolve-model-policy", malformed);
		}
		expect(responseCount).toBe(1);
	} finally {
		dispose?.();
		if (previousAgentDir === undefined) delete process.env.PI_COMPACTOR_AGENT_DIR;
		else process.env.PI_COMPACTOR_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});
