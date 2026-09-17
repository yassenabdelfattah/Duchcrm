/**
 * Placeholder for generated Supabase types.
 *
 * Regenerate after any migration:
 *
 *   npm run db:types
 *
 * which runs `supabase gen types typescript --local` and overwrites this file.
 * It is committed so the path exists and so a schema change shows up as a diff
 * in review rather than only on whoever happened to regenerate it.
 *
 * Until it is generated, the app uses hand-written row interfaces declared next
 * to the queries that read them.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = Record<string, never>;
