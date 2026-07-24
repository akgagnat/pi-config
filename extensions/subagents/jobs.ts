export type JobStatus = "initializing" | "working" | "done" | "failed" | "aborted";

/** A session-safe view: never expose callbacks, AbortControllers, or Promises in tool details. */
export type JobSnapshot = {
	id: string;
	name: string;
	agent: string;
	status: JobStatus;
	cwd: string;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
};

export function toJobSnapshot(job: JobSnapshot): JobSnapshot {
	return {
		id: job.id,
		name: job.name,
		agent: job.agent,
		status: job.status,
		cwd: job.cwd,
		startedAt: job.startedAt,
		updatedAt: job.updatedAt,
		...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
		...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
		...(job.stopReason === undefined ? {} : { stopReason: job.stopReason }),
		...(job.errorMessage === undefined ? {} : { errorMessage: job.errorMessage }),
	};
}

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
