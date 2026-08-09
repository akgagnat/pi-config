export class CompletionBatcher {
	private readonly pendingSuccesses = new Set<string>();
	private readonly outcomes = new Map<string, "success" | "failure">();
	private readonly reserved = new Set<string>();
	private readonly consumed = new Set<string>();
	private timer?: NodeJS.Timeout;

	constructor(
		private readonly windowMs: number,
		private readonly deliver: (ids: string[]) => void,
	) {}

	success(id: string): void {
		if (this.consumed.has(id)) return;
		this.outcomes.set(id, "success");
		if (!this.reserved.has(id)) this.scheduleSuccess(id);
	}

	failure(id: string): void {
		if (this.consumed.has(id)) return;
		this.outcomes.set(id, "failure");
		if (!this.reserved.has(id)) this.deliverOutcome(id, "failure");
	}

	reserve(ids: readonly string[]): void {
		for (const id of ids) {
			this.reserved.add(id);
			this.pendingSuccesses.delete(id);
		}
		this.clearEmptyTimer();
	}

	release(ids: readonly string[]): void {
		for (const id of ids) {
			this.reserved.delete(id);
			const outcome = this.outcomes.get(id);
			if (outcome === "success") this.scheduleSuccess(id);
			else if (outcome === "failure") this.deliverOutcome(id, outcome);
		}
	}

	consume(ids: readonly string[]): void {
		for (const id of ids) {
			this.reserved.delete(id);
			this.consumed.add(id);
			this.outcomes.delete(id);
			this.pendingSuccesses.delete(id);
		}
		this.clearEmptyTimer();
	}

	clear(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pendingSuccesses.clear();
		this.outcomes.clear();
		this.reserved.clear();
		this.consumed.clear();
	}

	private scheduleSuccess(id: string): void {
		this.pendingSuccesses.add(id);
		if (this.timer) return;
		this.timer = setTimeout(() => this.flushSuccesses(), this.windowMs);
		this.timer.unref();
	}

	private deliverOutcome(id: string, outcome: "success" | "failure"): void {
		this.outcomes.delete(id);
		this.deliver([id]);
	}

	private clearEmptyTimer(): void {
		if (this.pendingSuccesses.size === 0 && this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private flushSuccesses(): void {
		this.timer = undefined;
		const ids = [...this.pendingSuccesses];
		this.pendingSuccesses.clear();
		for (const id of ids) this.outcomes.delete(id);
		if (ids.length) this.deliver(ids);
	}
}
