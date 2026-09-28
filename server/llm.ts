import crypto from "node:crypto";
import { db } from "./db.ts";
import { config } from "./config.ts";
import { HttpError } from "./util.ts";

/**
 * The model layer for the case engine.
 *
 * This follows the same contract `gemini.ts` enforces for prices: a live answer
 * is best, a *real prior* answer is an acceptable degradation, and an invented
 * answer is never allowed. Concretely, every response is validated against the
 * caller's schema before it is returned or stored, and when the provider is
 * unreachable the only thing we will fall back to is a response we actually got
 * from the provider earlier for byte-identical input.
 *
 * The cache is TTL-less, unlike `price_cache`. A price is only true for a
 * moment; a model's answer to identical input is not. That difference is what
 * makes this file the offline backstop for the demo: any case that has been run
 * once replays from `llm_cache` with the network unplugged, and it replays the
 * response the model really produced rather than a scripted stand-in.
 */

/** The subset of JSON Schema the engine needs. Deliberately small. */
export type JsonSchema =
  | { type: "string"; enum?: string[]; maxLength?: number; nullable?: boolean }
  | { type: "number"; minimum?: number; maximum?: number; nullable?: boolean }
  | { type: "boolean"; nullable?: boolean }
  | { type: "array"; items: JsonSchema; maxItems?: number; nullable?: boolean }
  | {
      type: "object";
      properties: Record<string, JsonSchema>;
      required?: string[];
      nullable?: boolean;
    };

export type LlmCall<T> = { result: T; cached: boolean; model: string };

export type CallOptions = {
  /** Instructions that frame the task. Kept out of the cache key only if stable. */
  system?: string;
  prompt: string;
  /** The shape the answer must have. Enforced locally, never trusted to the provider. */
  schema: JsonSchema;
  /** Ignore a cached answer and ask the provider again. */
  refresh?: boolean;
  model?: string;
  timeoutMs?: number;
};

/**
 * Validate `value` against `schema`, returning human-readable errors.
 *
 * The provider is asked for JSON, but the provider is not trusted to have
 * honoured that — nothing reaches a ruling without passing through here.
 */
export function validateJson(value: unknown, schema: JsonSchema, path = "$"): string[] {
  if (schema.nullable && value === null) return [];
  const errors: string[] = [];
  const fail = (msg: string) => errors.push(`${path} ${msg}`);

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("must be an object");
        return errors;
      }
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined) fail(`is missing required property "${key}"`);
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (obj[key] === undefined) continue;
        errors.push(...validateJson(obj[key], sub, `${path}.${key}`));
      }
      return errors;
    }
    case "array": {
      if (!Array.isArray(value)) {
        fail("must be an array");
        return errors;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        fail(`must hold at most ${schema.maxItems} items`);
      }
      value.forEach((item, i) => errors.push(...validateJson(item, schema.items, `${path}[${i}]`)));
      return errors;
    }
    case "string": {
      if (typeof value !== "string") {
        fail("must be a string");
        return errors;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        fail(`must be at most ${schema.maxLength} characters`);
      }
      if (schema.enum && !schema.enum.includes(value)) {
        fail(`must be one of: ${schema.enum.join(", ")}`);
      }
      return errors;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail("must be a finite number");
        return errors;
      }
      if (schema.minimum !== undefined && value < schema.minimum) fail(`must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) fail(`must be <= ${schema.maximum}`);
      return errors;
    }
    case "boolean": {
      if (typeof value !== "boolean") fail("must be a boolean");
      return errors;
    }
  }
}

/** Stable identity of a call: same model, same frames, same schema → same row. */
export function promptHash(model: string, system: string | undefined, prompt: string, schema: JsonSchema): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([model, system ?? "", prompt, schema]))
    .digest("hex");
}

function readCache<T>(key: string, schema: JsonSchema, model: string): T | undefined {
  const row = db
    .prepare("SELECT model, response_json FROM llm_cache WHERE prompt_hash = ?")
    .get(key) as { model: string; response_json: string } | undefined;
  if (!row) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.response_json);
  } catch {
    // An unreadable row is worthless and must not be re-read forever.
    db.prepare("DELETE FROM llm_cache WHERE prompt_hash = ?").run(key);
    return undefined;
  }

  // The stored answer was valid for the schema it was produced under. If the
  // caller has since widened or tightened that schema the row no longer
  // describes this call, so drop it and ask the provider instead.
  const errors = validateJson(parsed, schema);
  if (errors.length > 0) {
    db.prepare("DELETE FROM llm_cache WHERE prompt_hash = ?").run(key);
    return undefined;
  }
  if (row.model !== model) {
    db.prepare("DELETE FROM llm_cache WHERE prompt_hash = ?").run(key);
    return undefined;
  }
  return parsed as T;
}

function writeCache(key: string, model: string, value: unknown): void {
  db.prepare(
    `INSERT INTO llm_cache (prompt_hash, model, response_json) VALUES (?, ?, ?)
     ON CONFLICT (prompt_hash) DO UPDATE SET
       model = excluded.model,
       response_json = excluded.response_json,
       created_at = datetime('now')`
  ).run(key, model, JSON.stringify(value));
}

/**
 * Extract the JSON payload from an assistant message.
 *
 * Models routinely wrap JSON in ```json fences even when asked not to, so the
 * fence is stripped rather than treated as a malformed answer.
 */
function parseJsonContent(content: string): unknown {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(content);
  const body = fenced?.[1] ?? content;
  return JSON.parse(body) as unknown;
}

async function requestCompletion(
  model: string,
  system: string | undefined,
  prompt: string,
  timeoutMs: number
): Promise<string> {
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: prompt },
  ];

  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      // `json_object` rather than `json_schema`: the latter is an OpenAI-only
      // extension that several compatible servers reject outright, and it buys
      // nothing here — the response is validated locally against the caller's
      // schema either way, so an unshaped object can never reach a ruling.
      response_format: { type: "json_object" },
      // Rulings must not wobble between runs: same evidence should produce the
      // same answer, or the precedent trail means nothing.
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`provider HTTP ${res.status}`);

  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") throw new Error("provider returned no content");
  return content;
}

/**
 * Ask the model for a JSON answer conforming to `schema`.
 *
 * Resolution order:
 *   1. a cached response for identical input (unless `refresh`), so an offline
 *      run replays a real answer;
 *   2. a live provider call, validated before it is returned or stored;
 *   3. the cached response again, if a live call failed.
 *
 * There is no fourth option. When none of the above yields a validated answer
 * this throws rather than returning something plausible.
 */
export async function callModel<T>(opts: CallOptions): Promise<LlmCall<T>> {
  const model = opts.model ?? config.llm.model;
  const timeoutMs = opts.timeoutMs ?? config.llm.timeoutMs;
  const key = promptHash(model, opts.system, opts.prompt, opts.schema);

  if (!opts.refresh) {
    const cached = readCache<T>(key, opts.schema, model);
    if (cached !== undefined) return { result: cached, cached: true, model };
  }

  if (!config.llm.configured) {
    throw new HttpError(
      502,
      "no LLM provider is configured (set LLM_API_KEY) and no cached response exists for this input",
    );
  }

  try {
    const content = await requestCompletion(model, opts.system, opts.prompt, timeoutMs);
    const parsed = parseJsonContent(content);
    const errors = validateJson(parsed, opts.schema);
    if (errors.length > 0) {
      // Invalid output is never cached — caching it would launder a bad answer
      // into the offline path, where it would look authoritative.
      throw new Error(`response did not match the schema: ${errors.slice(0, 3).join("; ")}`);
    }
    writeCache(key, model, parsed);
    return { result: parsed as T, cached: false, model };
  } catch (err) {
    const fallback = readCache<T>(key, opts.schema, model);
    if (fallback !== undefined) return { result: fallback, cached: true, model };
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, `LLM unavailable and no cached response for this input: ${msg}`);
  }
}
