/**
 * Outbound email (report delivery, run notifications). No external service is used in
 * this phase; a future SMTP/API provider implements the same interface.
 */
export interface EmailProvider {
  readonly id: string;
  /** True when messages actually leave the machine. */
  readonly deliversExternally: boolean;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: { fileName: string; storageKey: string; contentType: string }[];
}

export interface EmailSendResult {
  id: string;
  accepted: string[];
  /** Where the message went, e.g. a local outbox key. */
  destination: string;
}
