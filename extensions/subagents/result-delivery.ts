export class ResultDelivery<T extends { id: string }> {
	private pending = new Map<string, T>();
	private consumed = new Set<string>();

	defer(result: T): void {
		if (!this.consumed.has(result.id)) this.pending.set(result.id, result);
	}

	consume(ids: readonly string[]): void {
		for (const id of ids) {
			this.consumed.add(id);
			this.pending.delete(id);
		}
	}

	drain(): T[] {
		const results = [...this.pending.values()];
		this.pending.clear();
		return results;
	}

	clear(): void {
		this.pending.clear();
		this.consumed.clear();
	}
}
