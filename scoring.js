// Deterministic identification-level scoring.
//
// This is intentionally NOT "trust the model's self-reported confidence".
// The model (see schemas.js CANDIDATE_SCHEMA) only ever returns booleans
// and evidence lists describing WHAT it saw; this file is the single place
// that decides what those facts are worth. Codifying the bar here means a
// prompt change can't quietly lower the bar for calling something
// "confirmed".
//
// identification levels:
//   'confirmed' — 確認済み: tag/serial/exact-text evidence, no contradictions
//   'candidate' — 候補: some real evidence, but short of the confirmed bar
//   'unknown'   — 不明: no usable evidence, or insufficient photos

function computeIdentificationLevel(candidateResult, ocrResult) {
  if (!candidateResult) return "unknown";

  const brandCandidates = candidateResult.brand_candidates || [];
  const modelCandidates = candidateResult.model_candidates || [];
  const topBrand = brandCandidates[0];

  if (ocrResult && ocrResult.insufficient_photos) {
    // Not enough photographic evidence to say anything beyond category —
    // this must never be upgraded by brand/model output, however
    // confident-sounding it is.
    return "unknown";
  }

  const hasContradiction = !!(topBrand && topBrand.contradicting_evidence && topBrand.contradicting_evidence.length > 0);

  const modelConfirmed =
    candidateResult.model_number_confirmed_by_tag === true &&
    modelCandidates.some((m) => m.requires === "tag_or_serial_confirmed");

  const brandConfirmedByText =
    candidateResult.exact_ocr_brand_match === true &&
    !!topBrand &&
    topBrand.based_on === "exact_text_match" &&
    !hasContradiction;

  // "確認済み" requires the brand itself to be text-confirmed AND (a model
  // number read from a tag/serial, OR at least two independent supporting
  // clues with nothing contradicting them).
  if (brandConfirmedByText && (modelConfirmed || (topBrand.supporting_evidence || []).length >= 2)) {
    return "confirmed";
  }

  // A contradiction rules out "confirmed" (handled above) but the candidate
  // itself — flagged, evidence and contradiction both visible — is still
  // more useful to show than collapsing it to "no information at all".
  const hasAnyCandidate = brandCandidates.length > 0 || modelCandidates.length > 0;
  if (hasAnyCandidate) return "candidate";

  return "unknown";
}

const LEVEL_LABEL = {
  confirmed: "確認済み",
  candidate: "候補",
  unknown: "不明"
};

// Purely arithmetic, no AI involved — trims outliers (values further than
// 1.5x the IQR from the quartiles) then returns the median of what remains.
// Never claims a result when fewer than MIN_SAMPLES numbers are given.
const MIN_SAMPLES_FOR_ESTIMATE = 3;

function median(sortedNums) {
  const n = sortedNums.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedNums[mid - 1] + sortedNums[mid]) / 2 : sortedNums[mid];
}

// Outlier rejection via median absolute deviation (MAD) rather than
// quartiles: with the small sample sizes this deals with (typically 3-10
// user-entered sold prices), a single extreme value can itself dominate a
// quartile and hide from an IQR fence. MAD keeps the "typical" cluster as
// the reference point instead. Threshold 3.5 on the modified z-score is the
// standard robust-outlier constant (Iglewicz & Hoaglin).
function summarizeSoldPrices(prices) {
  const nums = (prices || []).map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (nums.length < MIN_SAMPLES_FOR_ESTIMATE) {
    return { count: nums.length, sufficient: false, median: null, low: null, high: null, trimmedCount: 0 };
  }
  const m = median(nums);
  const deviations = nums.map((n) => Math.abs(n - m));
  const mad = median(deviations.slice().sort((a, b) => a - b));

  let filtered;
  if (mad > 0) {
    filtered = nums.filter((n) => Math.abs((0.6745 * (n - m)) / mad) <= 3.5);
  } else {
    // Tight cluster (MAD collapses to 0): fall back to a plain "more than
    // half the median away" rule so we still catch one wild outlier.
    filtered = nums.filter((n) => Math.abs(n - m) <= m * 0.5);
  }
  // Never trim below the minimum usable sample size — if trimming would
  // leave too little to summarize, keep the original set instead.
  const useNums = filtered.length >= MIN_SAMPLES_FOR_ESTIMATE ? filtered : nums;
  return {
    count: nums.length,
    sufficient: true,
    median: median(useNums),
    low: useNums[0],
    high: useNums[useNums.length - 1],
    trimmedCount: nums.length - useNums.length
  };
}

// Profit calculation — plain arithmetic, fee rate and costs are all
// caller-supplied (never hardcoded), matching the requirement that nothing
// here is a fixed constant baked into code.
function calculateProfit({ salePrice, feeRate, shippingCost, purchasePrice, packagingCost, repairCost }) {
  const fee = salePrice * feeRate;
  const totalCost = (purchasePrice || 0) + (shippingCost || 0) + (packagingCost || 0) + (repairCost || 0);
  const profit = salePrice - fee - totalCost;
  // Break-even purchase price: the purchase price at which profit == 0,
  // given the other costs.
  const breakEvenPurchasePrice = salePrice - salePrice * feeRate - (shippingCost || 0) - (packagingCost || 0) - (repairCost || 0);
  return {
    fee,
    profit,
    breakEvenPurchasePrice,
    totalCost
  };
}

// Purchase recommendation. Deliberately conservative: withholds a "buy"
// recommendation whenever the identification or market evidence is thin,
// regardless of how good the profit number looks — a confident number
// built on an unconfirmed item or 1-2 sold comps is not something to act on.
function decideVerdict({ identificationLevel, soldSummary, profit, targetProfitMin, targetProfitMax, conditionFlagged }) {
  const reasons = [];
  if (identificationLevel === "unknown") reasons.push("商品を特定できていません");
  if (!soldSummary || !soldSummary.sufficient) reasons.push("売り切れ実績が不足しています(3件未満)");
  if (conditionFlagged) reasons.push("状態に要確認点があります(現物確認が必要)");

  if (reasons.length > 0) {
    return { verdict: "要確認", reasons };
  }
  if (profit >= targetProfitMin && profit <= targetProfitMax * 3) {
    if (profit >= targetProfitMin) return { verdict: "仕入れ候補", reasons: [] };
  }
  if (profit < targetProfitMin) {
    return { verdict: "見送り", reasons: ["想定利益が目標(" + targetProfitMin + "円)に届きません"] };
  }
  return { verdict: "仕入れ候補", reasons: [] };
}

if (typeof module !== "undefined") {
  module.exports = {
    computeIdentificationLevel,
    LEVEL_LABEL,
    summarizeSoldPrices,
    calculateProfit,
    decideVerdict,
    MIN_SAMPLES_FOR_ESTIMATE
  };
}
