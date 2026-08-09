export const CONTACT_PREFIX = "PI_SUBAGENT_CONTACT_V1:";
export const CONTACT_TITLE = "pi-subagent-contact-v1";
export const CONTACT_TIMEOUT_MS = 120_000;
export const CONTACT_MAX_BYTES = 20_000;

export type ContactKind = "decision" | "input" | "progress";

export type ContactEnvelope = {
	version: 1;
	requestId: string;
	kind: ContactKind;
	subject: string;
	message: string;
};

export function encodeContactEnvelope(envelope: ContactEnvelope): string {
	const encoded = `${CONTACT_PREFIX}${JSON.stringify(envelope)}`;
	if (Buffer.byteLength(encoded, "utf8") > CONTACT_MAX_BYTES) {
		throw new Error(`Supervisor request exceeds ${CONTACT_MAX_BYTES.toLocaleString("en-US")} UTF-8 bytes.`);
	}
	return encoded;
}

export function decodeContactEnvelope(value: unknown): ContactEnvelope | undefined {
	if (typeof value !== "string" || !value.startsWith(CONTACT_PREFIX) || Buffer.byteLength(value, "utf8") > CONTACT_MAX_BYTES) return undefined;
	try {
		const parsed = JSON.parse(value.slice(CONTACT_PREFIX.length)) as Partial<ContactEnvelope>;
		if (parsed.version !== 1 || typeof parsed.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.requestId)) return undefined;
		if (!(["decision", "input", "progress"] as const).includes(parsed.kind as ContactKind)) return undefined;
		if (typeof parsed.subject !== "string" || typeof parsed.message !== "string") return undefined;
		return parsed as ContactEnvelope;
	} catch {
		return undefined;
	}
}
