import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JobSnapshot, JobStore } from "./job-store.ts";

const WIDGET_KEY = "subagents-active";

function duration(startedAt: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function clean(value: string, limit = 100): string {
	const text = value.replace(/[\u0000-\u001f\u007f\u001b]/g, " ").replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function latestActivity(job: JobSnapshot): string {
	for (let index = job.timeline.length - 1; index >= 0; index--) {
		const event = job.timeline[index];
		if (event.type === "activity") return clean(event.message);
		if (event.type === "tool-start") return `tool ${clean(event.name)} running`;
		if (event.type === "steering") return `steering ${event.outcome}`;
		if (event.type === "escalation") return `supervisor request ${event.status}`;
	}
	return job.status === "initializing" ? "starting" : "working";
}

export function formatActiveJobWidget(store: JobStore, now = Date.now(), sessionId?: string): string[] {
	const active = store.list()
		.filter((job) => (!sessionId || job.parent.sessionId === sessionId) && (job.status === "initializing" || job.status === "working"))
		.sort((a, b) => a.startedAt - b.startedAt);
	if (active.length === 0) return [];
	return [
		`Subagents (${active.length} active)`,
		...active.map((job) => `• ${job.id} ${clean(job.name, 48)} · ${duration(job.startedAt, now)} · ${latestActivity(job)}`),
		"/subagents opens the read-only inspector",
	];
}

export class ActiveJobWidget {
	private unsubscribe?: () => void;
	private timer?: NodeJS.Timeout;
	private ctx?: ExtensionContext;
	private sessionId?: string;
	private renderedSignature?: string;
	private suspended = false;

	constructor(private readonly store: JobStore, private readonly intervalMs = 1_000) {}

	start(ctx: ExtensionContext): void {
		this.stop();
		if (ctx.mode !== "tui") return;
		this.ctx = ctx;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.suspended = false;
		this.unsubscribe = this.store.subscribe(() => this.render());
		this.render();
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.ctx?.ui.setWidget(WIDGET_KEY, undefined);
		this.ctx = undefined;
		this.sessionId = undefined;
		this.renderedSignature = undefined;
		this.suspended = false;
	}

	/** Hide the widget while another full-height extension component owns the editor area. */
	suspend(): void {
		if (!this.ctx || this.suspended) return;
		this.suspended = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.renderedSignature = undefined;
		this.ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	resume(): void {
		if (!this.ctx || !this.suspended) return;
		this.suspended = false;
		this.render();
	}

	private render(): void {
		if (!this.ctx || this.suspended) return;
		const lines = formatActiveJobWidget(this.store, Date.now(), this.sessionId);
		const signature = lines.join("\n");
		if (signature !== this.renderedSignature) {
			this.renderedSignature = signature;
			this.ctx.ui.setWidget(WIDGET_KEY, lines.length ? lines : undefined, { placement: "belowEditor" });
		}
		if (lines.length && !this.timer) {
			this.timer = setInterval(() => this.render(), this.intervalMs);
			this.timer.unref();
		} else if (!lines.length && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}
