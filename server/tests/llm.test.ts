import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JsonSchema } from "../llm.ts";

/**
 * The LLM contract: every answer is validated before it is used or stored, and
 * when the provider is unreachable the only acceptable fallback is a response
 * that provider really produced earlier. Nothing here touches the network — the
 * provider is a stubbed `fetch`.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyaya-llm-"));
process.env.DATA_DIR = tmp;
process.env.KEYS_DIR = tmp;
process.env.SEED_DEMO_ACCOUNTS = "false";
process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:1/none";
process.env.LLM_API_KEY = "test-key";
process.env.LLM_BASE_URL = "http://llm.invalid/v1";
process.env.LLM_MODEL = "test-model";

const { db } = await import("../db.ts");
const { config } = await import("../config.ts");
const { callModel, validateJson, promptHash } = await import("../llm.ts");

const MODEL = "test-model";

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["release_freelancer", "hold_buyer"] },
    amount: { type: "number", minimum: 0, nullable: true },
    reasons: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 3 },
  },
  required: ["decision", "amount", "reasons"],
};

// --- stubbed provider ----------------------------------------------------------

const realFetch = globalThis.fetch;
let requests: { url: string; body: any; signal?: AbortSignal | null }[] = [];
let respond: () => Promise<Response> = async () => {
  throw new Error("provider unreachable");
};

globalThis.fetch = (async (input: unknown, init?: { body?: unknown; signal?: AbortSignal | null }) => {
  requests.push({
    url: String(input),
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
    signal: init?.signal,
  });
  return respond();
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
});

function chatResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cacheRows(hash: string) {
  return db.prepare("SELECT * FROM llm_cache WHERE prompt_hash = ?").all(hash) as { response_json: string }[];
}

// --- schema validation ---------------------------------------------------------

test("validateJson reports shape violations", () => {
  const good = { decision: "hold_buyer", amount: 1500, reasons: ["buyer refused delivery"] };
  assert.deepEqual(validateJson(good, SCHEMA), []);

  // null is allowed only where the schema says so
  assert.deepEqual(validateJson({ ...good, amount: null }, SCHEMA), []);

  assert.match(validateJson({ amount: 1, reasons: [] }, SCHEMA).join(" "), /missing required property "decision"/);
  assert.match(validateJson({ ...good, decision: "maybe" }, SCHEMA).join(" "), /must be one of/);
  assert.match(validateJson({ ...good, amount: -5 }, SCHEMA).join(" "), /must be >= 0/);
  assert.match(validateJson({ ...good, amount: "1500" }, SCHEMA).join(" "), /\$\.amount must be a finite number/);
  assert.match(validateJson({ ...good, reasons: "nope" }, SCHEMA).join(" "), /\$\.reasons must be an array/);
  assert.match(validateJson({ ...good, reasons: ["a", "b", "c", "d"] }, SCHEMA).join(" "), /at most 3 items/);
  assert.match(validateJson({ ...good, reasons: [1] }, SCHEMA).join(" "), /\$\.reasons\[0\] must be a string/);
  assert.match(validateJson("nope", SCHEMA).join(" "), /must be an object/);
});

// --- caching -------------------------------------------------------------------

test("a live answer is validated, stored, then reused with no second request", async () => {
  const prompt = "case-1: client refuses to pay after delivery";
  respond = async () => chatResponse(JSON.stringify({ decision: "release_freelancer", amount: 0.12, reasons: ["delivery accepted"] }));
  requests = [];

  const first = await callModel<{ decision: string; reasons: string[] }>({ prompt, schema: SCHEMA });
  assert.equal(first.cached, false);
  assert.equal(first.model, MODEL);
  assert.equal(first.result.decision, "release_freelancer");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "http://llm.invalid/v1/chat/completions");
  assert.equal(requests[0]!.body.model, MODEL);
  assert.equal(requests[0]!.body.temperature, 0, "rulings must not wobble between runs");
  // The hard ceiling must actually reach the socket, or a hung provider holds
  // the ruling — and the demo — hostage indefinitely.
  assert.ok(requests[0]!.signal instanceof AbortSignal, "the call carries an abort signal");
  assert.equal(requests[0]!.signal!.aborted, false);

  const hash = promptHash(MODEL, undefined, prompt, SCHEMA);
  assert.equal(cacheRows(hash).length, 1);

  const second = await callModel<{ decision: string }>({ prompt, schema: SCHEMA });
  assert.equal(second.cached, true);
  assert.equal(second.result.decision, "release_freelancer");
  assert.equal(requests.length, 1, "the second call never reached the provider");
});

test("fenced JSON is unwrapped rather than treated as malformed", async () => {
  const prompt = "case-fenced";
  respond = async () => chatResponse('```json\n{"decision":"hold_buyer","amount":null,"reasons":[]}\n```');
  const out = await callModel<{ decision: string }>({ prompt, schema: SCHEMA });
  assert.equal(out.result.decision, "hold_buyer");
});

test("an answer that violates the schema is rejected and never cached", async () => {
  const prompt = "case-2: evidence contradicts itself";
  respond = async () => chatResponse(JSON.stringify({ decision: "maybe", reasons: [] }));
  requests = [];

  await assert.rejects(
    () => callModel({ prompt, schema: SCHEMA }),
    (err: any) => err.status === 502 && /did not match the schema/.test(err.message),
  );

  const hash = promptHash(MODEL, undefined, prompt, SCHEMA);
  assert.equal(cacheRows(hash).length, 0, "a bad answer must not be laundered into the offline path");

  // A subsequent good answer is still a live call, proving nothing was cached.
  respond = async () => chatResponse(JSON.stringify({ decision: "hold_buyer", amount: null, reasons: [] }));
  const retry = await callModel<{ decision: string }>({ prompt, schema: SCHEMA });
  assert.equal(retry.cached, false);
  assert.equal(retry.result.decision, "hold_buyer");
});

test("a failed call degrades to the real cached answer, never an invented one", async () => {
  const prompt = "case-3: already ruled once";
  respond = async () => chatResponse(JSON.stringify({ decision: "release_freelancer", amount: 2, reasons: ["milestone met"] }));
  const live = await callModel<{ decision: string }>({ prompt, schema: SCHEMA });
  assert.equal(live.cached, false);

  // The provider dies. refresh:true forces a live attempt, which must fall back
  // to the response it really gave before.
  respond = async () => {
    throw new Error("socket hang up");
  };
  const degraded = await callModel<{ decision: string }>({ prompt, schema: SCHEMA, refresh: true });
  assert.equal(degraded.cached, true);
  assert.equal(degraded.result.decision, "release_freelancer");
});

test("with no cached answer and no reachable provider, the call refuses", async () => {
  const prompt = "case-4: never seen before and the provider is down";
  respond = async () => {
    throw new Error("socket hang up");
  };
  await assert.rejects(
    () => callModel({ prompt, schema: SCHEMA }),
    (err: any) => err.status === 502 && /no cached response/.test(err.message),
  );
});

test("with no provider configured at all, an uncached call refuses", async () => {
  const prompt = "case-5: no provider";
  const wasConfigured = config.llm.configured;
  config.llm.configured = false;
  requests = [];
  try {
    await assert.rejects(
      () => callModel({ prompt, schema: SCHEMA }),
      (err: any) => err.status === 502 && /no LLM provider is configured/.test(err.message),
    );
    assert.equal(requests.length, 0);
  } finally {
    config.llm.configured = wasConfigured;
  }
});

test("the cache key covers the schema, so a changed contract misses", async () => {
  const prompt = "case-6: same words, different contract";
  respond = async () => chatResponse(JSON.stringify({ decision: "hold_buyer", amount: null, reasons: [] }));
  const first = await callModel({ prompt, schema: SCHEMA });
  assert.equal(first.cached, false);

  const narrower: JsonSchema = {
    type: "object",
    properties: { decision: { type: "string" } },
    required: ["decision"],
  };
  requests = [];
  const second = await callModel({ prompt, schema: narrower });
  assert.equal(second.cached, false, "a different schema is a different question");
  assert.equal(requests.length, 1);
});
