declare module 'pg-copy-streams' {
  import type { Submittable } from 'pg';
  import type { Readable, Writable } from 'node:stream';
  export function from(text: string): Writable & Submittable;
  export function to(text: string): Readable & Submittable;
}
