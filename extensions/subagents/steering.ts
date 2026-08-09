import type { JobStore } from "./job-store.ts";

export type SteeringDeliveryOutcome = "accepted" | "failed" | "unavailable";

export type SteeringDeliveryResult = {
	readonly jobId: string;
	readonly steeringId: string;
	readonly outcome: SteeringDeliveryOutcome;
	readonly message: string;
};

type SteeringSender = (instruction: string) => Promise<void>;

type ActiveChannel = {
	readonly send: SteeringSender;
	readonly settlement: Promise<void>;
	resolveSettlement: () => void;
	rejectSettlement: (error: Error) => void;
	unavailableReason?: string;
	inFlight: number;
	settlementObservedWhileSending: boolean;
	acceptedSinceObservedSettlement: boolean;
	settled: boolean;
};

const MAX_INSTRUCTION_BYTES = 20_000;

/** Linearizes steering, settlement, and cancellation without exposing callbacks in snapshots. */
export class SteeringRegistry {
	private readonly channels = new Map<string, ActiveChannel>();
	private nextSteeringNumber = 1;

	constructor(private readonly store: JobStore) {}

	register(jobId: string, send: SteeringSender): () => void {
		let resolveSettlement!: () => void;
		let rejectSettlement!: (error: Error) => void;
		const settlement = new Promise<void>((resolve, reject) => {
			resolveSettlement = resolve;
			rejectSettlement = reject;
		});
		// A cancellation may reject before runRpcAgent awaits this promise.
		void settlement.catch(() => {});
		const channel: ActiveChannel = {
			send,
			settlement,
			resolveSettlement,
			rejectSettlement,
			inFlight: 0,
			settlementObservedWhileSending: false,
			acceptedSinceObservedSettlement: false,
			settled: false,
		};
		this.channels.set(jobId, channel);
		return () => {
			if (this.channels.get(jobId) === channel) this.channels.delete(jobId);
		};
	}

	/** Final settlement only wins when no steering RPC is awaiting acknowledgement. */
	observeSettled(jobId: string): boolean {
		const channel = this.channels.get(jobId);
		if (!channel) return true;
		if (channel.settled) return channel.unavailableReason === "job has settled";
		if (channel.inFlight > 0) {
			channel.settlementObservedWhileSending = true;
			channel.acceptedSinceObservedSettlement = false;
			return false;
		}
		this.resolveSettlement(channel);
		return true;
	}

	markUnavailable(jobId: string, reason: string): void {
		const channel = this.channels.get(jobId);
		if (!channel || channel.settled) return;
		channel.unavailableReason = reason;
		channel.settled = true;
		channel.rejectSettlement(new Error(reason));
	}

	async waitForFinalSettlement(jobId: string, timeoutMs: number): Promise<void> {
		const channel = this.channels.get(jobId);
		if (!channel) throw new Error(`Steering lifecycle is unavailable for ${jobId}.`);
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				channel.settlement,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(`Timed out waiting for subagent settlement after ${timeoutMs}ms.`)), timeoutMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async deliver(jobId: string, instruction: string): Promise<SteeringDeliveryResult> {
		const job = this.store.get(jobId);
		if (!job) throw new Error(`Unknown subagent job: ${jobId}`);
		const text = instruction.trim();
		if (!text) throw new Error("Steering instruction must not be empty.");
		if (Buffer.byteLength(text, "utf8") > MAX_INSTRUCTION_BYTES) {
			throw new Error(`Steering instruction exceeds ${MAX_INSTRUCTION_BYTES.toLocaleString("en-US")} UTF-8 bytes.`);
		}
		const steeringId = `steer-${String(this.nextSteeringNumber++).padStart(4, "0")}`;
		this.record(jobId, steeringId, text, "requested");
		const channel = this.channels.get(jobId);
		const unavailableReason = job.status !== "working"
			? `job is ${job.status}`
			: channel?.unavailableReason ?? (!channel ? "RPC child is not available" : undefined);
		if (unavailableReason) {
			this.record(jobId, steeringId, text, "unavailable", unavailableReason);
			throw new Error(`Cannot steer ${jobId}: ${unavailableReason}.`);
		}

		channel!.inFlight++;
		try {
			// send writes synchronously before yielding. Cancellation after this point may
			// terminate the child, but cannot reopen or replace its lifecycle channel.
			await channel!.send(text);
			channel!.acceptedSinceObservedSettlement = channel!.settlementObservedWhileSending || channel!.acceptedSinceObservedSettlement;
			const message = "RPC accepted the instruction for the child's steering queue; child compliance is not guaranteed.";
			this.record(jobId, steeringId, text, "accepted", message);
			return { jobId, steeringId, outcome: "accepted", message };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.record(jobId, steeringId, text, "failed", message);
			throw new Error(`Failed to steer ${jobId}: ${message}`);
		} finally {
			channel!.inFlight--;
			if (channel!.inFlight === 0 && channel!.settlementObservedWhileSending) {
				if (channel!.acceptedSinceObservedSettlement) {
					channel!.settlementObservedWhileSending = false;
					channel!.acceptedSinceObservedSettlement = false;
				} else {
					this.resolveSettlement(channel!);
				}
			}
		}
	}

	private resolveSettlement(channel: ActiveChannel): void {
		if (channel.settled) return;
		channel.settled = true;
		channel.unavailableReason = "job has settled";
		channel.resolveSettlement();
	}

	private record(
		jobId: string,
		steeringId: string,
		instruction: string,
		outcome: "requested" | SteeringDeliveryOutcome,
		message?: string,
	): void {
		this.store.appendTimeline(jobId, {
			type: "steering",
			steeringId,
			instruction,
			outcome,
			...(message ? { message } : {}),
			at: Date.now(),
		});
	}
}
