export type JobStatus = "initializing" | "working" | "done" | "failed" | "aborted";

export type ManagedJob<T> = {
	id: string;
	name: string;
	status: JobStatus;
	result?: T;
};

export class JobManager<T> {
	private readonly jobs = new Map<string, ManagedJob<T>>();
	private readonly completions = new Map<string, Promise<T>>();

	constructor(private readonly maxRunning: number, private readonly makeId: () => string) {}

	start(name: string, run: () => Promise<T>): ManagedJob<T> {
		if (this.running().length >= this.maxRunning) throw new Error(`Too many running subagents. Max is ${this.maxRunning}.`);
		const job: ManagedJob<T> = { id: this.makeId(), name, status: "initializing" };
		this.jobs.set(job.id, job);
		const completion = run().then(
			(result) => {
				job.result = result;
				job.status = "done";
				return result;
			},
			(error) => {
				job.status = "failed";
				throw error;
			},
		);
		this.completions.set(job.id, completion);
		return job;
	}

	get(id: string): ManagedJob<T> | undefined {
		return this.jobs.get(id);
	}

	list(): ManagedJob<T>[] {
		return [...this.jobs.values()];
	}

	async wait(ids: string[]): Promise<T[]> {
		return Promise.all(ids.map((id) => {
			const completion = this.completions.get(id);
			if (!completion) throw new Error(`Unknown subagent job: ${id}`);
			return completion;
		}));
	}

	private running(): ManagedJob<T>[] {
		return this.list().filter((job) => job.status === "initializing" || job.status === "working");
	}
}
