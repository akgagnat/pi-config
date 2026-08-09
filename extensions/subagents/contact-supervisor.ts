import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CONTACT_TIMEOUT_MS, CONTACT_TITLE, encodeContactEnvelope, type ContactKind } from "./contact-protocol.ts";

export default function contactSupervisorExtension(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT !== "1") return;
	pi.registerTool({
		name: "contact_supervisor",
		label: "Contact Supervisor",
		description: "Escalate material ambiguity to the parent supervisor or send a non-blocking progress update. Do not use for routine completion handoff.",
		promptSnippet: "Ask the parent supervisor for a blocking decision/input, or send a progress update.",
		promptGuidelines: [
			"Use contact_supervisor only for material ambiguity or missing information that blocks the delegated task, not routine status or completion handoff.",
			"Use contact_supervisor progress sparingly; continue working after a progress update.",
		],
		parameters: Type.Object({
			kind: StringEnum(["decision", "input", "progress"] as const),
			subject: Type.String({ minLength: 1 }),
			message: Type.String({ minLength: 1 }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const envelope = encodeContactEnvelope({
				version: 1,
				requestId: randomUUID(),
				kind: params.kind as ContactKind,
				subject: params.subject.trim(),
				message: params.message.trim(),
			});
			if (params.kind === "progress") {
				ctx.ui.notify(envelope, "info");
				return { content: [{ type: "text", text: "Progress update sent to the supervisor." }], details: { kind: params.kind } };
			}
			if (signal?.aborted) throw new Error("Supervisor request cancelled.");
			const reply = await ctx.ui.input(CONTACT_TITLE, envelope, { timeout: CONTACT_TIMEOUT_MS, signal });
			if (reply === undefined) throw new Error("Supervisor request timed out or was cancelled.");
			return { content: [{ type: "text", text: `Supervisor reply: ${reply}` }], details: { kind: params.kind } };
		},
	});
}
