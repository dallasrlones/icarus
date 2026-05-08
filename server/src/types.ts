export type Role = "user" | "assistant" | "system";

export type PillPhase = "pending" | "applied" | "rejected";

export interface Pill {
  id: string;
  phase: PillPhase;
  kind?: string;
  result?: unknown;
  error?: string;
  body?: string;
}

export interface Message {
  id: string;
  role: Role;
  text: string;
  createdAt: number;
  pills?: Pill[];
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface Chat extends ChatSummary {
  messages: Message[];
}
