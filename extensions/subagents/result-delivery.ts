export class ResultDelivery<T extends { id: string }> {
	private pending = new Map<string, T>();
	private consumed = new Set<string>();
	private delivered = new Set<string>();

	defer(result: T): void {
		if (!this.consumed.has(result.id)) this.pending.set(result.id, result);
	}

	consume(ids: readonly string[]): void {
		for (const id of ids) {
			this.consumed.add(id);
			this.pending.delete(id);
		}
	}

	assertNotDelivered(ids: readonly string[]): void {
		const delivered = ids.find((id) => this.delivered.has(id));
		if (delivered) throw new Error(`Subagent ${delivered} completion notification is already queued.`);
	}

	take(ids: readonly string[]): T[] {
		const results: T[] = [];
		for (const id of ids) {
			const result = this.pending.get(id);
			if (result) {
				results.push(result);
				this.delivered.add(id);
			}
			this.pending.delete(id);
		}
		return results;
	}

	drain(): T[] {
		const results = [...this.pending.values()];
		for (const result of results) this.delivered.add(result.id);
		this.pending.clear();
		return results;
	}

	clear(): void {
		this.pending.clear();
		this.consumed.clear();
		this.delivered.clear();
	}
}
