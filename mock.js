// Deliberately kept in its own file, never imported unless
// settings.mockMode is on and the UI is showing the "モックモード" banner —
// see app.js. This exists so the screen flow can be exercised without
// spending real API calls, and so it's structurally impossible to confuse
// with a real result (different code path, not just a flag deep inside one
// function).

const MOCK_DETECTION = {
  items: [
    { box_2d: [120, 60, 420, 340], category: "バッグ", visible_features: "茶色のレザートートバッグ、持ち手は2本" },
    { box_2d: [150, 400, 380, 620], category: "財布", visible_features: "黒い二つ折り財布" },
    { box_2d: [500, 100, 780, 380], category: "靴", visible_features: "ベージュのスエード靴、片方のみ写っている" }
  ]
};

const MOCK_OCR = {
  ocr_fragments: [
    { image_index: 0, raw_text: "COACH", location: "内側の刻印タグ", text_confidence: "high" },
    { image_index: 1, raw_text: "MADE IN", location: "内タグ下部、続きは折れて読めず", text_confidence: "low" }
  ],
  visual_features: {
    color: "茶色",
    material_guess: "本革(自然なシボあり)",
    hardware: "ゴールド金具、重量感あり",
    stitching_quality: "均一で密なステッチ",
    iconic_pattern_observed: "特になし",
    notable_marks: "持ち手の付け根に軽い擦れ"
  },
  condition_notes: "底面に軽い擦れ、目立つ傷はなし",
  insufficient_photos: false,
  missing_angles: []
};

const MOCK_CANDIDATE = {
  brand_candidates: [
    {
      brand: "COACH",
      based_on: "exact_text_match",
      supporting_evidence: ["内側の刻印タグに「COACH」の文字", "金具の質感がブランドの傾向と一致"],
      contradicting_evidence: []
    }
  ],
  model_candidates: [],
  exact_ocr_brand_match: true,
  model_number_confirmed_by_tag: false,
  iconic_pattern_match: false,
  category_only_reason: "",
  warnings: ["型番タグは未確認のため、型番までは判定していません"]
};

if (typeof window !== "undefined") {
  window.MockData = { MOCK_DETECTION, MOCK_OCR, MOCK_CANDIDATE };
}
