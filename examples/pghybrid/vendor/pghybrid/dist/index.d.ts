/**
 * Configuration objects describing the table being searched.
 *
 * A {@link Config} is the only thing the SQL builder needs. It is deliberately
 * declarative and free of connection details so that the same object can generate a
 * migration, a search query and a diagnostic report.
 *
 * The object is a plain literal rather than a class: a config that has to be
 * constructed cannot be written in a JSON file, loaded from an environment, or spread
 * over a default, and all three are things people do with this.
 */
type VectorType = "vector" | "halfvec";
type FusionMethod = "rrf" | "weighted";
/** "numeric" produces $1, $2 (node-postgres, asyncpg, raw SQL, Supabase). */
/** "pyformat" produces %s (psycopg 2 and 3), for a Python service sharing this config. */
type ParamStyle = "numeric" | "pyformat";
/**
 * "any" OR-combines the query terms so the keyword signal still ranks when no
 * document contains every word; "all" keeps Postgres' native AND semantics.
 */
type TextMatch = "any" | "all";
type QueryParser = "websearch_to_tsquery" | "plainto_tsquery" | "phraseto_tsquery";
type RankFunction = "ts_rank_cd" | "ts_rank";
/**
 * The RRF constant from Cormack, Clarke & Buettcher (2009), "Reciprocal Rank Fusion
 * outperforms Condorcet and individual rank learning methods". 60 is their reported
 * value and remains the sane default: it flattens the difference between the top few
 * ranks so neither signal can dominate on its first result alone.
 */
declare const DEFAULT_RRF_K = 60;
/** A pgvector distance metric and the index operator classes that match it. */
interface Metric {
    readonly name: string;
    readonly operator: string;
    readonly opsVector: string;
    readonly opsHalfvec: string;
    /**
     * Whether a smaller value means a closer match. Every pgvector operator is a
     * distance, so this is always true; it exists to keep the ranking code honest.
     */
    readonly ascending: boolean;
}
declare const COSINE: Metric;
declare const L2: Metric;
declare const INNER_PRODUCT: Metric;
declare const L1: Metric;
declare const METRICS: {
    readonly cosine: Metric;
    readonly l2: Metric;
    readonly euclidean: Metric;
    readonly inner_product: Metric;
    readonly ip: Metric;
    readonly l1: Metric;
    readonly manhattan: Metric;
};
type MetricName = keyof typeof METRICS;
/** The operator class an index on the vector column must use for this metric. */
declare function opsFor(metric: Metric, vectorType: VectorType): string;
/**
 * Relative influence of each signal.
 *
 * Under RRF these behave the way they read, because both terms are computed from
 * ranks and therefore share a scale. Under `weighted` fusion they do not.
 */
interface Weights {
    vector?: number;
    text?: number;
}
/**
 * Exponential decay applied to the fused score.
 *
 * `halfLifeDays` is the age at which a row's score is halved. Rows with a NULL
 * timestamp are left undecayed rather than dropped.
 *
 * Decay **reranks the candidates, it does not retrieve them.** Both signals pick their
 * top `candidateLimit` rows on relevance alone, and the decay is applied to that pool
 * afterwards, so a very recent row that no signal ranked highly cannot surface however
 * aggressive the half-life is. Measured on a 300-row table with a one-day half-life and
 * one row published today at relevance rank 250: invisible at `candidateLimit: 20`,
 * first at `candidateLimit: 300`.
 *
 * That is deliberate. Retrieving on recency would mean a third candidate set ordered by
 * timestamp, which returns recent rows nobody searched for, or scanning the table,
 * which is what the indexes exist to avoid. If recent-but-unrelated rows genuinely
 * belong in your results, raise `candidateLimit` until the pool is wide enough to
 * contain them, and expect to pay for the wider scan.
 */
interface Recency {
    column: string;
    halfLifeDays: number;
}
/**
 * Describes one searchable table.
 *
 * Only `table`, `textColumn` and `vectorColumn` are required. Everything else has a
 * defensible default, and every default is stated in the README so the behaviour is
 * never a surprise.
 */
interface Config {
    table: string;
    textColumn: string;
    vectorColumn: string;
    idColumn?: string;
    /**
     * A stored tsvector column. Leave it undefined to have the query compute the
     * tsvector inline, which needs no migration but cannot use a GIN index.
     */
    tsvectorColumn?: string | null;
    language?: string;
    /**
     * Upper bound on the terms taken from one query under "any" matching.
     *
     * Each term becomes another parser call OR-ed into the statement, and past roughly
     * 4,200 of them Postgres gives up with "stack depth limit exceeded", an alarming
     * message for what is really "you pasted a document into the search box". Terms beyond
     * the limit are dropped, which costs nothing real: ts_rank_cd over hundreds of terms
     * has stopped discriminating long before this.
     */
    maxQueryTerms?: number;
    vectorType?: VectorType;
    metric?: MetricName | Metric;
    fusion?: FusionMethod;
    k?: number;
    weights?: Weights;
    /**
     * How many rows each signal contributes to the fusion. Larger values find more
     * rows that one signal ranked poorly, at a proportional cost per query.
     */
    candidateLimit?: number;
    filterColumns?: readonly string[];
    extraColumns?: readonly string[];
    recency?: Recency | null;
    queryParser?: QueryParser;
    rankFunction?: RankFunction;
    /**
     * Placeholder style for the driver you use. Getting this wrong is the first thing
     * that breaks for a new user, so it is explicit rather than guessed.
     */
    paramStyle?: ParamStyle;
    /**
     * See {@link TextMatch}. "any" is the default because AND semantics make the
     * keyword half of a hybrid search return nothing for most multi-word queries, which
     * silently degrades the whole system to vector-only search.
     */
    textMatch?: TextMatch;
    headlineOptions?: string;
    /**
     * Escape `&`, `<` and `>` in the document before `ts_headline` runs. Defaults to true.
     *
     * The default delimiters are HTML, so the whole point of `highlight` is that you render
     * it. That makes the surrounding document text active markup unless something escapes
     * it, and Postgres does not: its parser drops tags it recognises, which is why
     * `<script>alert(1)</script>` disappears and looks safe, but `<img src=x onerror=alert(1)>`
     * and `<svg/onload=alert(1)>` come through intact. Relying on that is relying on which
     * shapes one particular parser happens to recognise.
     *
     * Escaping first is the fix and it costs nothing: only the three characters change, so
     * every word still matches and the highlighting is identical. Turn it off if you have set
     * `headlineOptions` to delimiters that are not HTML, such as `**` for Markdown.
     */
    escapeHighlight?: boolean;
}
/** A {@link Config} with every default filled in and every value checked. */
interface ResolvedConfig {
    readonly table: string;
    readonly textColumn: string;
    readonly vectorColumn: string;
    readonly idColumn: string;
    readonly tsvectorColumn: string | null;
    readonly language: string;
    readonly maxQueryTerms: number;
    readonly vectorType: VectorType;
    readonly metric: Metric;
    readonly fusion: FusionMethod;
    readonly k: number;
    readonly weights: {
        readonly vector: number;
        readonly text: number;
    };
    readonly candidateLimit: number;
    readonly filterColumns: readonly string[];
    readonly extraColumns: readonly string[];
    readonly recency: Recency | null;
    readonly queryParser: QueryParser;
    readonly rankFunction: RankFunction;
    readonly paramStyle: ParamStyle;
    readonly textMatch: TextMatch;
    readonly headlineOptions: string;
    readonly escapeHighlight: boolean;
}
declare const DEFAULT_HEADLINE_OPTIONS = "StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MinWords=8, MaxWords=30";
declare function resolveConfig(config: Config): ResolvedConfig;
/** The operator class an index on the config's vector column must use. */
declare function opsClass(config: Config): string;

/**
 * SQL generation for hybrid search on plain Postgres.
 *
 * Everything in this module is a pure function of a {@link Config} and the call
 * arguments. Nothing here touches a database, which is what makes the generated SQL
 * auditable, snapshot-testable, and copy-pasteable by people who never install the
 * package.
 *
 * The generated statement is one query with two candidate CTEs, one per signal,
 * fused by Reciprocal Rank Fusion. Filters are applied *inside* each CTE so that both
 * signals search the same subset of rows; applying them after the fusion silently
 * destroys recall, which is the single most common way a hand-rolled implementation
 * goes wrong.
 *
 * It has a twin: the Python package generates the same statement byte for byte, and
 * `scripts/check_parity.mjs` fails the build when the two disagree. Any change here
 * that alters the emitted text has to be made there too.
 */

/** Raised when a table or column name cannot be safely interpolated. */
declare class IdentifierError extends Error {
    constructor(message: string);
}
/**
 * Validate and double-quote a Postgres identifier.
 *
 * Qualified names (`schema.table`) are supported and each part is validated
 * separately, so `public.chunks` becomes `"public"."chunks"`.
 */
declare function quoteIdent(name: string): string;
/** One rendered statement and the values to bind to it, in order. */
interface BuiltQuery {
    sql: string;
    params: unknown[];
}
/**
 * Accumulates bind parameters and renders them in the driver's placeholder style.
 *
 * Every value that originates outside the config, the query text, the embedding,
 * limits, filter values, goes through here, so the generated SQL never contains an
 * interpolated literal.
 *
 * Placeholders are emitted as opaque tokens during assembly and resolved in
 * {@link Params.render}. That indirection exists because `$1` may be referenced twice
 * in one statement while `%s` may not: numbered styles deduplicate, positional styles
 * have to repeat the value. Writing the placeholder text at the point of use would
 * force the builder to know which of those it is emitting, in every branch.
 */
declare class Params {
    private readonly slots;
    add(value: unknown): string;
    addCast(value: unknown, cast: string): string;
    /** Substitute placeholders and return the statement with its final values. */
    render(sql: string, paramStyle: ParamStyle): BuiltQuery;
}
/** Anything a caller may filter on. Arrays and Sets become `= ANY($n)`. */
type Filters = Record<string, unknown>;
/** Arguments for one call to {@link buildSearchSql}. */
interface BuildOptions {
    embedding?: readonly number[] | null;
    text?: string | null;
    limit: number;
    offset?: number;
    filters?: Filters | null;
    candidateLimit?: number | null;
    nearMiss?: number;
    highlight?: boolean;
    fusion?: FusionMethod | null;
}
/**
 * Build the hybrid search statement and its bind parameters.
 *
 * Either signal may be omitted: passing only `embedding` produces a pure vector search
 * and only `text` a pure full-text search, both with the same output columns, which is
 * what makes a three-way comparison of the two signals honest.
 *
 * `nearMiss` extends the result set past `limit` so callers can show the rows that just
 * missed the cut, the ones that are usually the reason a search "failed".
 */
declare function buildSearchSql(config: Config, options: BuildOptions): BuiltQuery;
/**
 * Render a vector in pgvector's text input format.
 *
 * Passing the vector as text and casting keeps the package driver-agnostic: it works
 * with node-postgres, postgres.js, Drizzle and Supabase without any of them
 * registering a pgvector type adapter.
 */
declare function formatVector(embedding: readonly number[]): string;

/**
 * Turning a user's search box into a tsquery that is useful for ranking.
 *
 * Postgres' query parsers all combine terms with AND. `websearch_to_tsquery` turns
 * `renewal notice period` into `'renew' & 'notic' & 'period'`, which matches only
 * documents containing all three. For a filter that is correct; for the keyword half
 * of a hybrid search it is quietly destructive, because a query of four or five words
 * usually matches nothing at all and the fusion silently degrades to vector-only
 * search without reporting that anything went wrong.
 *
 * So the default here is ANY: terms are OR-ed, and documents matching more of them
 * rank higher because `ts_rank_cd` already accounts for that. Precision is recovered
 * by ranking rather than by exclusion, which is how a search engine is supposed to
 * behave.
 *
 * The OR is built by tokenising the query and combining one `websearch_to_tsquery`
 * call per term with the `||` operator, rather than by rewriting the operators inside
 * a parsed tsquery. Rewriting looks simpler and is wrong: `'a' & !'b'` becomes
 * `'a' | !'b'`, which matches every document that merely lacks `b`.
 */
/** A search box split into terms to include and terms to exclude. */
interface ParsedQuery {
    readonly positive: string[];
    readonly negative: string[];
    /** True when nothing in the string survived tokenising. */
    readonly isEmpty: boolean;
}
/**
 * Split a raw search string into positive and negative terms.
 *
 * Supports the syntax people already expect from a search box: double-quoted phrases
 * are kept whole, and a leading `-` excludes a term.
 *
 * ```ts
 * parseQuery('renewal "notice period" -pricing');
 * // { positive: ["renewal", "notice period"], negative: ["pricing"], isEmpty: false }
 * ```
 */
declare function parseQuery(text: string | null | undefined): ParsedQuery;

/**
 * Running the generated statement, and shaping what comes back.
 *
 * pghybrid never opens a connection. A {@link HybridSearch} is built around an
 * `execute` callable that takes `(sql, params)` and returns rows, which is what lets
 * the package work with node-postgres, postgres.js, Drizzle or the Supabase client
 * without importing any of them and without holding an opinion about pooling,
 * transactions or retries:
 *
 * ```ts
 * const search = new HybridSearch(config, (sql, params) =>
 *   pool.query(sql, params).then((result) => result.rows));
 * ```
 *
 * The row shaping is the part worth being careful about. A row found by only one
 * signal has a NULL rank for the other, and the natural implementation,
 * `Number(row.text_rank)`, turns that into NaN on exactly the rows hybrid search
 * exists to surface. Every conversion here tolerates NULL and says so.
 */

/** One row as the driver returned it. Anything object-like survives {@link rowMapping}. */
type Row = Record<string, unknown>;
/**
 * What the caller's `execute` is expected to be. It may be synchronous, which keeps
 * the door open for drivers that are.
 */
type Executor$1 = (sql: string, params: unknown[]) => Promise<Iterable<unknown>> | Iterable<unknown>;
/** Which signals retrieved a row. */
type MatchedBy = "both" | "vector" | "text" | "none";
/**
 * One ranked row, with the arithmetic that produced its position kept intact.
 *
 * The decomposition is not decoration. When a search result looks wrong the only
 * useful question is which signal put it there, and a bare `{ id, score }` cannot
 * answer it. Both ranks, both raw scores and both fused contributions travel with
 * every row so the answer is always one property away.
 *
 * `vectorRank` and `textRank` are null when that signal did not retrieve the row at
 * all, which is different from retrieving it last.
 */
interface SearchResult {
    id: unknown;
    score: number;
    fusedScore: number;
    vectorRank: number | null;
    vectorDistance: number | null;
    vectorContribution: number;
    textRank: number | null;
    textScore: number | null;
    textContribution: number;
    recencyFactor: number | null;
    highlight: string | null;
    /** Which signals retrieved this row: `both`, `vector`, `text` or `none`. */
    matchedBy: MatchedBy;
    /** The columns copied through from the table (`textColumn` plus `extraColumns`). */
    row: Row;
}
/**
 * Coerce one driver row into a plain object.
 *
 * Drivers disagree about what a row is: node-postgres returns plain objects,
 * postgres.js returns array-like rows with named properties, and some query builders
 * return a Map. Accepting all of them here is what keeps the `execute` callable a
 * one-liner instead of an adapter the user has to write.
 */
declare function rowMapping(row: unknown): Row;
/**
 * Number conversion that passes NULL through instead of turning it into NaN.
 *
 * Also normalises the strings a driver returns for bigint and numeric columns, the
 * rank() window function is a bigint, so node-postgres hands back "2" rather than 2,
 * so a caller never has to think about which driver produced a score.
 */
declare function asFloat(value: unknown): number | null;
/**
 * Build a {@link SearchResult} from one driver row.
 *
 * Anything the query added beyond the ranking columns is passed through in `row`
 * rather than dropped, because the caller usually needs the title next to the score.
 */
declare function resultFromRow(row: unknown): SearchResult;
/** Shape a whole result set. The ordering the database produced is preserved. */
declare function resultsFromRows(rows: Iterable<unknown> | null | undefined): SearchResult[];
/** Everything a caller may vary from one search to the next. */
interface SearchOptions {
    embedding?: readonly number[] | null;
    limit?: number;
    offset?: number;
    filters?: Filters | null;
    candidateLimit?: number | null;
    /** Extra rows past `limit`, for showing the ones that just missed the cut. */
    nearMiss?: number;
    highlight?: boolean;
    fusion?: FusionMethod | null;
}
/**
 * Hybrid search over one table, driven by an `execute` callable.
 *
 * `execute(sql, params)` must run the statement and return the rows as objects.
 * Everything else, connecting, pooling, retrying, tracing, stays in the caller's
 * code where it belongs.
 */
declare class HybridSearch {
    readonly config: Config;
    readonly execute: Executor$1;
    constructor(config: Config, execute: Executor$1);
    /**
     * The statement {@link HybridSearch.search} would run, without running it.
     *
     * Worth exposing: the fastest way to debug a ranking is to paste the query into psql
     * and edit it, and the fastest way to trust a library is to read what it sends.
     */
    buildQuery(text?: string | null, options?: SearchOptions): BuiltQuery;
    /**
     * Rank rows by both signals at once.
     *
     * Passing only `text` runs a pure full-text search and only `embedding` a pure
     * vector search, both returning the same shape, which is what makes comparing the
     * three an apples-to-apples exercise.
     */
    search(text?: string | null, options?: SearchOptions): Promise<SearchResult[]>;
}

/**
 * One-line wiring for the drivers people actually have.
 *
 * `HybridSearch` takes an `execute` callable, which keeps this package free of driver
 * dependencies but leaves every user writing the same closure. These helpers write it
 * for you, and each one is typed structurally rather than against the driver's own
 * types, so importing this module pulls in nothing.
 *
 * Every Postgres driver in JavaScript uses `$1` placeholders, so unlike the Python side
 * there is no style to get wrong here, but the helpers set it explicitly anyway, in
 * case a config arrives with `paramStyle: "pyformat"` copied from a Python example.
 *
 * ```ts
 * import { forPg } from "pghybrid/adapters";
 * const search = forPg(pool, { table: "chunks", textColumn: "content", vectorColumn: "embedding" });
 * ```
 */

/** node-postgres: `Pool` and `Client` both satisfy this. */
interface PgLike {
    query(text: string, values?: unknown[]): Promise<{
        rows: Row[];
    }>;
}
/** postgres.js: the tagged-template function, which also carries `.unsafe`. */
interface PostgresJsLike {
    unsafe(query: string, parameters?: unknown[]): PromiseLike<unknown>;
}
/** Drizzle exposes the driver it was constructed with as `$client`. */
interface DrizzleLike {
    $client?: PgLike;
    execute?(query: unknown): Promise<unknown>;
}
/**
 * Kysely runs raw statements through `executeQuery` with a compiled query.
 *
 * The parameter is `any` on purpose. A `CompiledQuery` carries Kysely's full operation
 * node union plus an opaque `queryId`, and restating enough of that here to keep a real
 * `Kysely<T>` assignable would mean copying types that are not ours and will drift.
 * The shape actually passed is built below and is exercised against a live Kysely in
 * the test suite, which is a better guarantee than a hand-copied type.
 */
interface KyselyLike {
    executeQuery(query: any): Promise<{
        rows: Row[];
    }>;
}
type Executor = (sql: string, params: unknown[]) => Promise<Row[]>;
/** node-postgres (`pg`). Accepts a `Pool` or a `Client`. */
declare function pgExecutor(client: PgLike): Executor;
declare function forPg(client: PgLike, config: Config): HybridSearch;
/**
 * postgres.js.
 *
 * `unsafe` is the documented way to run a statement this library built, and it is not
 * a security hole here: the statement contains no interpolated values, only `$n`
 * placeholders, and every value still travels as a bound parameter.
 */
declare function postgresJsExecutor(sql: PostgresJsLike): Executor;
declare function forPostgresJs(sql: PostgresJsLike, config: Config): HybridSearch;
/**
 * Drizzle.
 *
 * Goes through `$client`, the driver Drizzle was constructed with, because Drizzle's own
 * `execute` takes a query object rather than a statement and a parameter list, and
 * building one from raw SQL loses the bound parameters, which is the wrong trade.
 */
declare function drizzleExecutor(db: DrizzleLike): Executor;
declare function forDrizzle(db: DrizzleLike, config: Config): HybridSearch;
/** Kysely, via a raw compiled query so the parameters stay bound. */
declare function kyselyExecutor(db: KyselyLike): Executor;
declare function forKysely(db: KyselyLike, config: Config): HybridSearch;

/** Hybrid search on plain Postgres. */

declare const VERSION = "0.1.4";

export { type BuildOptions, type BuiltQuery, COSINE, type Config, DEFAULT_HEADLINE_OPTIONS, DEFAULT_RRF_K, type DrizzleLike, type Executor$1 as Executor, type Filters, type FusionMethod, HybridSearch, INNER_PRODUCT, IdentifierError, type KyselyLike, L1, L2, METRICS, type MatchedBy, type Metric, type MetricName, type ParamStyle, Params, type ParsedQuery, type PgLike, type PostgresJsLike, type QueryParser, type RankFunction, type Recency, type ResolvedConfig, type Row, type SearchOptions, type SearchResult, type TextMatch, VERSION, type VectorType, type Weights, asFloat, buildSearchSql, drizzleExecutor, forDrizzle, forKysely, forPg, forPostgresJs, formatVector, kyselyExecutor, opsClass, opsFor, parseQuery, pgExecutor, postgresJsExecutor, quoteIdent, resolveConfig, resultFromRow, resultsFromRows, rowMapping };
