import type { Anchor, AnchorRateError, DepositRate, DepositRateComparison } from '@/types';
import { getAnchorsByCorridorId, getCorridorById, sep38AssetId } from './anchors';
import { resolveAnchor as resolveAnchorToml } from './sep1';
import {
  findSep24AssetInfo,
  getSep24Info as fetchSep24Info,
  listEnabledAssets,
  type Sep24AssetInfo,
} from './sep24';
import { referenceMidPrice as fetchReferenceMidPrice } from '@/lib/fx/reference-mid';

/**
 * Deposit (on-ramp) quote engine (ONR012): the one server-side answer to
 * "for X NGN, anchor A would credit about Y of asset Z".
 *
 * Every figure here is *indicative*. SEP-24 publishes deposit fees in /info,
 * but the fiat→asset conversion is only set inside the anchor's interactive
 * flow, so each estimate is a documented reference price (Q38017's
 * `referenceMidPrice`) minus the anchor's own published fees — the mirror of
 * the withdraw-side `indicativeRate` in `server-rates.ts`.
 */

export type DepositFundingType = 'bank_account' | 'cash' | 'mobile_money';

/** Injectable network dependencies, overridden in tests. */
export interface DepositRateDeps {
  resolveAnchor?: typeof resolveAnchorToml;
  getSep24Info?: typeof fetchSep24Info;
  referenceMidPrice?: typeof fetchReferenceMidPrice;
}

export interface DepositEstimateOptions {
  /**
   * SEP-24 funding method. Published /info fees do not vary by method, so it
   * does not change the estimate today; it is part of the signature so the
   * /fee-style refinement can slot in without breaking callers.
   */
  type?: DepositFundingType;
  /** Corridor to attribute the row to, when the caller already knows it. */
  corridorId?: string;
  deps?: DepositRateDeps;
}

export interface FetchDepositRatesOptions {
  /** Restrict rows to one asset: a SEP-38 identifier (`stellar:CODE:ISSUER`) or bare code. */
  asset?: string;
  /** See `DepositEstimateOptions.type`. */
  type?: DepositFundingType;
  deps?: DepositRateDeps;
}

/**
 * Thrown when no reference price exists for an (asset, fiat) pair — an empty
 * or too-wide SDEX book, or an FX lookup failure. Distinct from fee/info
 * failures so the on-ramp hop can map it to its `no_exchange_rate` code.
 */
export class NoDepositRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoDepositRateError';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Attributes a row to one of the anchor's registered corridors by matching
 * the credited asset and payout fiat; falls back to the conventional
 * `<code>-<fiat>` id for assets the registry has no corridor for yet.
 */
function inferCorridorId(
  anchor: Anchor,
  asset: { code: string; issuer: string | null },
  fiatCode: string
): string {
  for (const id of anchor.corridors) {
    try {
      const corridor = getCorridorById(id);
      if (corridor.to === fiatCode && corridor.from === asset.code) return id;
    } catch {
      // Unregistered corridor id on the anchor; keep looking.
    }
  }
  return `${asset.code}-${fiatCode}`.toLowerCase();
}

/**
 * Builds one (anchor, asset) row: fiat → asset through the reference mid
 * price, minus the anchor's published SEP-24 deposit fees (asset units, the
 * same convention as the withdraw-side estimate). Throws `NoDepositRateError`
 * when no usable reference price exists.
 */
async function buildDepositRow(
  anchor: Anchor,
  asset: { code: string; issuer: string | null },
  assetInfo: Sep24AssetInfo | null,
  fiatCode: string,
  fiatAmount: number,
  corridorId: string,
  deps: DepositRateDeps
): Promise<DepositRate> {
  const referenceMid = deps.referenceMidPrice ?? fetchReferenceMidPrice;

  if (!Number.isFinite(fiatAmount) || fiatAmount <= 0) {
    throw new Error(`invalid fiat amount "${fiatAmount}" for a ${fiatCode} deposit`);
  }

  let reference;
  try {
    reference = await referenceMid(asset, fiatCode);
  } catch (err) {
    throw new NoDepositRateError(
      `no ${asset.code}→${fiatCode} reference price: ${errorMessage(err)}`
    );
  }
  if (!Number.isFinite(reference.price) || reference.price <= 0) {
    throw new NoDepositRateError(
      `unusable ${asset.code}→${fiatCode} reference price ${reference.price}`
    );
  }

  const feeFixed = assetInfo?.fee_fixed ?? 0;
  const feePercent = assetInfo?.fee_percent ?? 0;
  // reference.price is fiat per 1 asset; convert, then apply fees the same way
  // the withdraw-side indicativeRate does (fixed first, then percent).
  const grossAsset = fiatAmount / reference.price;
  const totalReceived = Math.max(0, grossAsset - feeFixed) * (1 - feePercent / 100);
  const exchangeRate = totalReceived / fiatAmount;

  const feeType: DepositRate['feeType'] =
    feeFixed > 0 && feePercent > 0 ? 'combined' : feePercent > 0 ? 'percent' : 'flat';

  return {
    anchorId: anchor.id,
    anchorName: anchor.name,
    corridorId,
    asset: sep38AssetId(asset),
    fiatAmount,
    fee: feeFixed > 0 ? feeFixed : null,
    feeType,
    exchangeRate,
    totalReceived,
    ...(assetInfo?.min_amount !== undefined ? { minAmount: assetInfo.min_amount } : {}),
    ...(assetInfo?.max_amount !== undefined ? { maxAmount: assetInfo.max_amount } : {}),
    source: 'sep24-fee',
    referenceSource: reference.detail,
    updatedAt: new Date(),
  };
}

/**
 * Estimates what one anchor would credit for a fiat deposit of `fiatAmount`
 * `fiatCode` into `asset` (#1496). Resolves the anchor's TOML and SEP-24
 * /info itself so the router's on-ramp hop and `fetchDepositRates` produce
 * the same figure for the same inputs.
 *
 * Throws `NoDepositRateError` when no reference price exists; any other
 * throw means the anchor's TOML or /info could not be used.
 */
export async function estimateDepositForAnchor(
  anchor: Anchor,
  asset: { code: string; issuer: string | null },
  fiatCode: string,
  fiatAmount: string,
  opts: DepositEstimateOptions = {}
): Promise<DepositRate> {
  const deps = opts.deps ?? {};
  const resolveToml = deps.resolveAnchor ?? resolveAnchorToml;
  const getInfo = deps.getSep24Info ?? fetchSep24Info;

  const toml = await resolveToml(anchor.serviceDomain ?? anchor.homeDomain);
  const transferServer = toml.TRANSFER_SERVER_SEP0024;
  if (!transferServer) {
    throw new Error(`${anchor.name} advertises no SEP-24 transfer server`);
  }

  const info = await getInfo(transferServer);
  const assetInfo = findSep24AssetInfo(info, 'deposit', asset.code, asset.issuer ?? undefined);
  if (assetInfo && assetInfo.enabled === false) {
    throw new Error(`${anchor.name} does not enable ${asset.code} deposits`);
  }

  const corridorId = opts.corridorId ?? inferCorridorId(anchor, asset, fiatCode);
  return buildDepositRow(anchor, asset, assetInfo, fiatCode, Number(fiatAmount), corridorId, deps);
}

/**
 * Fetches indicative deposit estimates for every anchor on a corridor
 * (ONR012). Each anchor's enabled deposit assets come from its SEP-24 /info
 * via `listEnabledAssets`; an anchor whose /info lists nothing usable falls
 * back to its registered asset until the multi-asset registry lands. Failures
 * are isolated per (anchor, asset) into `errors` — one failing anchor never
 * rejects the comparison. Rows are sorted by `totalReceived` descending.
 */
export async function fetchDepositRates(
  corridorId: string,
  fiatAmount: string,
  opts: FetchDepositRatesOptions = {}
): Promise<DepositRateComparison> {
  const corridor = getCorridorById(corridorId); // throws on unknown corridor
  const anchors = getAnchorsByCorridorId(corridorId);
  const fiatCode = corridor.to;
  const fiatAmountNum = Number(fiatAmount);
  const deps = opts.deps ?? {};
  const resolveToml = deps.resolveAnchor ?? resolveAnchorToml;
  const getInfo = deps.getSep24Info ?? fetchSep24Info;

  const rates: DepositRate[] = [];
  const errors: AnchorRateError[] = [];

  await Promise.all(
    anchors.map(async (anchor) => {
      try {
        const toml = await resolveToml(anchor.serviceDomain ?? anchor.homeDomain);
        const transferServer = toml.TRANSFER_SERVER_SEP0024;
        if (!transferServer) {
          throw new Error('anchor advertises no SEP-24 transfer server');
        }
        const info = await getInfo(transferServer);

        let assets: Array<{ code: string; issuer: string | null; assetInfo: Sep24AssetInfo | null }> =
          listEnabledAssets(info, 'deposit').map((entry) => ({
            code: entry.code,
            issuer: entry.issuer,
            assetInfo: entry.info,
          }));
        if (assets.length === 0) {
          // Registry fallback: /info listed nothing usable, but quoting the
          // anchor's registered asset (with whatever fee data /info holds for
          // it) is still better than dropping the anchor entirely.
          const fallbackInfo = findSep24AssetInfo(info, 'deposit', anchor.assetCode, anchor.assetIssuer);
          if (fallbackInfo && fallbackInfo.enabled === false) {
            throw new Error(`anchor does not enable ${anchor.assetCode} deposits`);
          }
          assets = [{ code: anchor.assetCode, issuer: anchor.assetIssuer, assetInfo: fallbackInfo }];
        }
        if (opts.asset) {
          assets = assets.filter(
            (a) => sep38AssetId(a) === opts.asset || a.code === opts.asset
          );
        }

        await Promise.all(
          assets.map(async ({ code, issuer, assetInfo }) => {
            try {
              rates.push(
                await buildDepositRow(
                  anchor,
                  { code, issuer },
                  assetInfo,
                  fiatCode,
                  fiatAmountNum,
                  corridorId,
                  deps
                )
              );
            } catch (err) {
              errors.push({
                anchorId: anchor.id,
                anchorName: anchor.name,
                reason: `${code}: ${errorMessage(err)}`,
              });
            }
          })
        );
      } catch (err) {
        errors.push({
          anchorId: anchor.id,
          anchorName: anchor.name,
          reason: errorMessage(err),
        });
      }
    })
  );

  rates.sort((a, b) => (b.totalReceived ?? -Infinity) - (a.totalReceived ?? -Infinity));
  const best = rates.find((r) => (r.totalReceived ?? 0) > 0);

  return { corridorId, direction: 'deposit', rates, bestRateId: best?.anchorId ?? '', errors };
}
