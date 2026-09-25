// Where the allow-list comes from.
//
// The Merkle path needs two inputs: the root, which is on-chain and authoritative,
// and the member list, which is not. SeaDrop stores only the root — the list lives
// off-chain, and whether it is published at all is the creator's choice. Most
// OpenSea drops never publish it, which is why the capability matrix marks
// `merkle-allowlist` detection as a warning rather than a yes.
//
// So this module does not pretend to discover the list. It loads one the operator
// points at, from a file or a URL, in whichever of the common shapes it arrives
// in. The root comparison in merkle.ts is what decides whether the list was the
// right one — parsing successfully proves nothing.

import fs from "fs";
import { AllowListEntry, MintParams } from "./merkle";

export interface AllowListSource {
  entries: AllowListEntry[];
  /** Human-readable provenance, printed next to the eligibility verdict. */
  origin: string;
}

function bigintField(raw: unknown, field: string): bigint {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      throw new Error(`Allow-list field "${field}" is not a whole number: ${raw}`);
    }
    return BigInt(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      return BigInt(raw.trim());
    } catch {
      throw new Error(`Allow-list field "${field}" is not a number: ${raw}`);
    }
  }
  throw new Error(`Allow-list is missing required field "${field}".`);
}

function boolField(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === 1 || raw === "1") return true;
  if (raw === "false" || raw === 0 || raw === "0") return false;
  throw new Error(`Allow-list field "${field}" is not a boolean: ${String(raw)}`);
}

/**
 * Read mint params from a record, accepting the several names generators use for
 * the same field. Unknown names are not guessed at — a missing field throws,
 * because a defaulted zero would change the leaf and produce a root mismatch that
 * looks like "wrong list" rather than "we invented a value".
 */
export function parseMintParams(raw: Record<string, unknown>): MintParams {
  const pick = (...names: string[]): unknown => {
    for (const n of names) if (raw[n] !== undefined) return raw[n];
    return undefined;
  };
  return {
    mintPrice: bigintField(pick("mintPrice", "price"), "mintPrice"),
    maxTotalMintableByWallet: bigintField(
      pick("maxTotalMintableByWallet", "maxMintable", "limit"),
      "maxTotalMintableByWallet",
    ),
    startTime: bigintField(pick("startTime", "start"), "startTime"),
    endTime: bigintField(pick("endTime", "end"), "endTime"),
    dropStageIndex: bigintField(pick("dropStageIndex", "stageIndex"), "dropStageIndex"),
    maxTokenSupplyForStage: bigintField(
      pick("maxTokenSupplyForStage", "maxSupplyForStage"),
      "maxTokenSupplyForStage",
    ),
    feeBps: bigintField(pick("feeBps", "fee"), "feeBps"),
    restrictFeeRecipients: boolField(
      pick("restrictFeeRecipients", "restrict"),
      "restrictFeeRecipients",
    ),
  };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Parse an allow-list document.
 *
 * Four shapes are accepted because four shapes are what generators emit:
 *
 *   [{minter, mintParams}]            per-member params
 *   {entries: [...]}                  the same, wrapped
 *   {mintParams, minters: ["0x…"]}    one stage, many wallets — the common case
 *   ["0x…", "0x…"]                    bare addresses, needing `shared` params
 *
 * Per-member params win over shared ones. A member with neither is an error, not
 * a member with zeroed params.
 */
export function parseAllowList(
  doc: unknown,
  shared?: MintParams,
): AllowListEntry[] {
  const fromRecord = (value: unknown, fallback?: MintParams): AllowListEntry => {
    if (typeof value === "string") {
      if (!ADDRESS.test(value.trim())) {
        throw new Error(`Allow-list entry is not an address: ${value}`);
      }
      if (!fallback) {
        throw new Error(
          `Allow-list entry ${value} has no mint params, and none were supplied ` +
            `for the stage. The window and price are hashed into the leaf, so they ` +
            `cannot be defaulted.`,
        );
      }
      return { minter: value.trim(), params: fallback };
    }
    if (typeof value !== "object" || value === null) {
      throw new Error(`Allow-list entry is not an object or address: ${String(value)}`);
    }
    const rec = value as Record<string, unknown>;
    const minter = rec.minter ?? rec.address ?? rec.wallet;
    if (typeof minter !== "string" || !ADDRESS.test(minter.trim())) {
      throw new Error(`Allow-list entry has no valid minter address.`);
    }
    const paramsRaw = rec.mintParams ?? rec.params;
    if (paramsRaw && typeof paramsRaw === "object") {
      return {
        minter: minter.trim(),
        params: parseMintParams(paramsRaw as Record<string, unknown>),
      };
    }
    // Params flattened onto the entry itself.
    if (rec.startTime !== undefined || rec.mintPrice !== undefined) {
      return { minter: minter.trim(), params: parseMintParams(rec) };
    }
    if (!fallback) {
      throw new Error(
        `Allow-list entry ${minter} has no mint params, and none were supplied ` +
          `for the stage.`,
      );
    }
    return { minter: minter.trim(), params: fallback };
  };

  if (Array.isArray(doc)) return doc.map((v) => fromRecord(v, shared));

  if (typeof doc === "object" && doc !== null) {
    const rec = doc as Record<string, unknown>;
    const stageParams =
      rec.mintParams && typeof rec.mintParams === "object"
        ? parseMintParams(rec.mintParams as Record<string, unknown>)
        : shared;
    const list = rec.entries ?? rec.minters ?? rec.addresses ?? rec.allowList;
    if (Array.isArray(list)) return list.map((v) => fromRecord(v, stageParams));
  }

  throw new Error(
    "Allow-list document is not a recognised shape. Expected an array of entries, " +
      "or an object with an `entries` / `minters` array.",
  );
}

const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

/**
 * Load an allow-list from a local path, an http(s) URL, or ipfs://.
 *
 * Network fetches use Node's built-in fetch — no HTTP dependency — and carry a
 * timeout, because this runs during pre-arm and a hung request must not eat the
 * countdown.
 */
export async function loadAllowList(
  spec: string,
  shared?: MintParams,
  timeoutMs = 10_000,
): Promise<AllowListSource> {
  const trimmed = spec.trim();
  if (trimmed === "") throw new Error("No allow-list source given.");

  let text: string;
  let origin: string;

  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("ipfs://")) {
    const url = trimmed.startsWith("ipfs://")
      ? IPFS_GATEWAY + trimmed.slice("ipfs://".length)
      : trimmed;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Allow-list fetch failed: HTTP ${res.status} from ${url}`);
      }
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    origin = url;
  } else {
    if (!fs.existsSync(trimmed)) {
      throw new Error(`Allow-list file not found: ${trimmed}`);
    }
    text = fs.readFileSync(trimmed, "utf8");
    origin = trimmed;
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`Allow-list at ${origin} is not valid JSON.`);
  }

  const entries = parseAllowList(doc, shared);
  if (entries.length === 0) {
    throw new Error(`Allow-list at ${origin} parsed to zero members.`);
  }
  return { entries, origin };
}
