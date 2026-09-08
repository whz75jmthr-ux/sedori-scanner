// Plain node:assert tests — no test framework dependency, runnable with
// `node test/scoring.test.js`. Kept deliberately small and readable so the
// scoring bar (what counts as "confirmed") stays auditable.
const assert = require("assert");
const {
  computeIdentificationLevel,
  summarizeSoldPrices,
  calculateProfit,
  decideVerdict,
  MIN_SAMPLES_FOR_ESTIMATE
} = require("../scoring.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok - " + name);
  } catch (e) {
    console.error("FAIL - " + name);
    console.error(e);
    process.exitCode = 1;
  }
}

test("no evidence at all -> unknown", () => {
  const level = computeIdentificationLevel(
    { brand_candidates: [], model_candidates: [], exact_ocr_brand_match: false, model_number_confirmed_by_tag: false },
    { insufficient_photos: false }
  );
  assert.strictEqual(level, "unknown");
});

test("insufficient photos always forces unknown, even with a confident-looking candidate result", () => {
  const level = computeIdentificationLevel(
    {
      brand_candidates: [{ brand: "COACH", based_on: "exact_text_match", supporting_evidence: ["tag text", "logo"], contradicting_evidence: [] }],
      model_candidates: [],
      exact_ocr_brand_match: true,
      model_number_confirmed_by_tag: false
    },
    { insufficient_photos: true }
  );
  assert.strictEqual(level, "unknown");
});

test("exact tag text match + 2 supporting clues, no contradiction -> confirmed", () => {
  const level = computeIdentificationLevel(
    {
      brand_candidates: [{ brand: "COACH", based_on: "exact_text_match", supporting_evidence: ["内タグの刻印", "金具の意匠"], contradicting_evidence: [] }],
      model_candidates: [],
      exact_ocr_brand_match: true,
      model_number_confirmed_by_tag: false
    },
    { insufficient_photos: false }
  );
  assert.strictEqual(level, "confirmed");
});

test("exact text match but only 1 supporting clue and no model tag -> candidate, not confirmed", () => {
  const level = computeIdentificationLevel(
    {
      brand_candidates: [{ brand: "COACH", based_on: "exact_text_match", supporting_evidence: ["内タグの刻印"], contradicting_evidence: [] }],
      model_candidates: [],
      exact_ocr_brand_match: true,
      model_number_confirmed_by_tag: false
    },
    { insufficient_photos: false }
  );
  assert.strictEqual(level, "candidate");
});

test("iconic pattern only (no exact text) -> candidate at best, never confirmed", () => {
  const level = computeIdentificationLevel(
    {
      brand_candidates: [{ brand: "推定ブランド", based_on: "iconic_pattern", supporting_evidence: ["モノグラム柄"], contradicting_evidence: [] }],
      model_candidates: [],
      exact_ocr_brand_match: false,
      model_number_confirmed_by_tag: false
    },
    { insufficient_photos: false }
  );
  assert.strictEqual(level, "candidate");
});

test("contradicting evidence present -> never confirmed even with exact match flag", () => {
  const level = computeIdentificationLevel(
    {
      brand_candidates: [{ brand: "COACH", based_on: "exact_text_match", supporting_evidence: ["タグ"], contradicting_evidence: ["金具の質感が異なる"] }],
      model_candidates: [],
      exact_ocr_brand_match: true,
      model_number_confirmed_by_tag: false
    },
    { insufficient_photos: false }
  );
  assert.strictEqual(level, "candidate");
});

test("summarizeSoldPrices: fewer than MIN_SAMPLES -> insufficient, no fabricated median", () => {
  const s = summarizeSoldPrices([3000, 3200]);
  assert.strictEqual(s.sufficient, false);
  assert.strictEqual(s.median, null);
  assert.strictEqual(MIN_SAMPLES_FOR_ESTIMATE, 3);
});

test("summarizeSoldPrices: trims an obvious outlier before taking the median", () => {
  const s = summarizeSoldPrices([3000, 3200, 3100, 3300, 50000]);
  assert.strictEqual(s.sufficient, true);
  assert.ok(s.high < 50000, "outlier should have been trimmed from the high end");
  assert.strictEqual(s.median, 3150);
});

test("calculateProfit: 10% fee, matches manual arithmetic", () => {
  const r = calculateProfit({ salePrice: 10000, feeRate: 0.1, shippingCost: 700, purchasePrice: 3000, packagingCost: 100, repairCost: 0 });
  // fee = 1000; total cost = 3000+700+100 = 3800; profit = 10000-1000-3800 = 5200
  assert.strictEqual(r.fee, 1000);
  assert.strictEqual(r.profit, 5200);
});

test("decideVerdict: withholds recommendation when identification is unknown, regardless of profit", () => {
  const v = decideVerdict({
    identificationLevel: "unknown",
    soldSummary: { sufficient: true },
    profit: 8000,
    targetProfitMin: 1000,
    targetProfitMax: 5000,
    conditionFlagged: false
  });
  assert.strictEqual(v.verdict, "要確認");
});

test("decideVerdict: withholds recommendation when sold comps are insufficient", () => {
  const v = decideVerdict({
    identificationLevel: "confirmed",
    soldSummary: { sufficient: false },
    profit: 3000,
    targetProfitMin: 1000,
    targetProfitMax: 5000,
    conditionFlagged: false
  });
  assert.strictEqual(v.verdict, "要確認");
});

test("decideVerdict: confirmed + sufficient comps + profit in range -> 仕入れ候補", () => {
  const v = decideVerdict({
    identificationLevel: "confirmed",
    soldSummary: { sufficient: true },
    profit: 3000,
    targetProfitMin: 1000,
    targetProfitMax: 5000,
    conditionFlagged: false
  });
  assert.strictEqual(v.verdict, "仕入れ候補");
});

test("decideVerdict: profit below target -> 見送り", () => {
  const v = decideVerdict({
    identificationLevel: "confirmed",
    soldSummary: { sufficient: true },
    profit: 300,
    targetProfitMin: 1000,
    targetProfitMax: 5000,
    conditionFlagged: false
  });
  assert.strictEqual(v.verdict, "見送り");
});

console.log(passed + " test(s) passed");
