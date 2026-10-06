import { randomUUID } from "node:crypto";
import type { StorageProvider } from "@/lib/storage/provider";
import type { EmailMessage, EmailProvider, EmailSendResult } from "./provider";

/** Writes outgoing messages as JSON files to local storage (`outbox/`) instead of sending them. */
export class LocalOutboxEmailProvider implements EmailProvider {
  readonly id = "local-outbox";
  readonly deliversExternally = false;

  constructor(private readonly storage: StorageProvider) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (message.to.length === 0) throw new Error("Email has no recipients.");
    const id = randomUUID();
    const key = `outbox/${new Date().toISOString().slice(0, 10)}/${id}.json`;
    const body = JSON.stringify({ id, createdAt: new Date().toISOString(), ...message }, null, 2);
    await this.storage.put(key, new TextEncoder().encode(body), { contentType: "application/json" });
    return { id, accepted: message.to, destination: key };
  }
}
