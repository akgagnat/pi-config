export class ResultDelivery<T extends { id: string }> {
	private pending = new Map<string, T>();

	defer(result: T): void {
		this.pending.set(result.id, result);
	}

	consume(ids: readonly string[]): void {
		for (const id of ids) this.pending.delete(id);
	}

	drain(): T[] {
		const results = [...this.pending.values()];
		this.pending.clear();
		return results;
	}

	clear(): void {
		this.pending.clear();
	}
}
