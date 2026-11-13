// Generated from app.manifest.yaml (tickets 1.0.0) by "archipel types". Do not edit.

export interface Ticket {
  id: string;
  title: string;
  status: "open" | "done" | null;
  customer_id: string | null;
}

export interface TicketInsert {
  id?: string;
  title: string;
  status?: "open" | "done" | null;
  customer_id?: string | null;
}

export type TicketUpdate = Partial<TicketInsert>;

export interface Tables {
  "ticket": { row: Ticket; insert: TicketInsert; update: TicketUpdate };
  "shared.customer": { row: Record<string, unknown>; insert: Record<string, unknown>; update: Record<string, unknown> };
}
