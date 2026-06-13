import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
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
			ctx.compact({
				customInstructions: params.instructions,
				onError: (error) => {
					console.error("[pi-compactor] compaction failed:", error.message);
				},
			});
			return {
				content: [{ type: "text", text: "Compaction triggered." }],
				details: {},
			};
		},
	});
}
