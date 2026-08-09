import assert from "node:assert/strict";
import test from "node:test";

import contactSupervisorExtension from "../extensions/subagents/contact-supervisor.ts";
import { decodeContactEnvelope } from "../extensions/subagents/contact-protocol.ts";

test("contact_supervisor is child-only and supports progress plus blocking replies", async () => {
	const previous = process.env.PI_SUBAGENT;
	try {
		delete process.env.PI_SUBAGENT;
		let registered: any;
		contactSupervisorExtension({ registerTool(tool: any) { registered = tool; } } as any);
		assert.equal(registered, undefined);

		process.env.PI_SUBAGENT = "1";
		contactSupervisorExtension({ registerTool(tool: any) { registered = tool; } } as any);
		assert.ok(registered);
		const tool = registered as any;
		assert.equal(tool.name, "contact_supervisor");
		let notice = "";
		const progress = await tool.execute("call", { kind: "progress", subject: "Status", message: "Still working" }, undefined, undefined, {
			ui: { notify(message: string) { notice = message; } },
		});
		assert.equal(decodeContactEnvelope(notice)?.kind, "progress");
		assert.match(progress.content[0].text, /sent/);

		let request = "";
		const decision = await tool.execute("call", { kind: "decision", subject: "Choose", message: "A or B?" }, undefined, undefined, {
			ui: { input: async (_title: string, placeholder: string) => { request = placeholder; return "A"; } },
		});
		assert.equal(decodeContactEnvelope(request)?.kind, "decision");
		assert.match(decision.content[0].text, /Supervisor reply: A/);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT;
		else process.env.PI_SUBAGENT = previous;
	}
});
