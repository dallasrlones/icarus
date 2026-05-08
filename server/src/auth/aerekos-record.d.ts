/**
 * Minimal ambient types for the `aerekos-record` package (no shipped
 * .d.ts as of 0.1.4). Only the SQLite surface used by icarus's auth
 * module is declared here — everything else stays `any` so downstream
 * usage isn't tightly coupled to internal helpers.
 */

declare module "aerekos-record" {
  export type SqliteSettings = {
    database: string;
    verbose?: (sql: string) => void;
  };

  export type ModelProperty =
    | "string"
    | "number"
    | "boolean"
    | "datetime"
    | "encrypted";

  export type ModelOptions = {
    required?: string[];
    unique?: string[];
    indexes?: string[];
    timestamps?: boolean;
    softDelete?: boolean;
    callbacks?: Record<string, (...args: unknown[]) => unknown>;
  };

  export type Where = Record<string, unknown>;

  export interface Model<T extends Record<string, unknown>> {
    create(attrs: Partial<T>, opts?: { ttl?: number }): Promise<T & { id: string }>;
    find(id: string, opts?: { withDeleted?: boolean }): Promise<(T & { id: string }) | null>;
    findBy(where: Where): Promise<(T & { id: string }) | null>;
    findOneBy(where: Where): Promise<(T & { id: string }) | null>;
    findAll(opts?: {
      where?: Where;
      order?: Record<string, "asc" | "desc"> | string;
      limit?: number;
      offset?: number;
      withDeleted?: boolean;
      select?: string[];
    }): Promise<(T & { id: string })[]>;
    count(where?: Where): Promise<number>;
    update(
      id: string,
      changes: Partial<T>,
      opts?: { ttl?: number },
    ): Promise<T & { id: string }>;
    updateBy(where: Where, changes: Partial<T>): Promise<number>;
    delete(id: string, opts?: { hardDelete?: boolean }): Promise<boolean>;
  }

  export interface Database {
    model<T extends Record<string, unknown>>(
      name: string,
      props: Record<string, ModelProperty>,
      options?: ModelOptions,
    ): Model<T>;
    healthCheck(): Promise<{ status: string; [k: string]: unknown }>;
    close(): Promise<void>;
  }

  export function connect(type: "sqlite", settings: SqliteSettings): Database;
  export function connect(type: string, settings: Record<string, unknown>): Database;
}
