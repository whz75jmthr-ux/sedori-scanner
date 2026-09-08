// Static reference data: which extra angles to ask for per category, and
// what condition risks to flag. None of this is AI-generated — it's fixed
// domain knowledge, so it can't hallucinate or drift between calls.

const RESHOOT_ANGLES = {
  "バッグ": ["正面", "背面", "内側", "ブランドロゴ", "内タグ", "型番・シリアル番号", "ファスナーや金具", "角や底面", "値札"],
  "財布": ["正面", "背面", "内側", "ブランドロゴ", "内タグ", "型番・シリアル番号", "ファスナーや金具", "角や底面", "値札"],
  "靴": ["両足の全体", "インソールのロゴ", "シュータン裏のタグ", "サイズ表記", "靴底", "かかと", "型番", "値札"],
  "アウター": ["全体", "首元のブランドタグ", "洗濯表示タグ", "品番タグ", "素材表記", "傷や汚れ", "値札"],
  "衣類": ["全体", "首元のブランドタグ", "洗濯表示タグ", "品番タグ", "素材表記", "傷や汚れ", "値札"],
  "小物": ["全体", "ブランドロゴ", "タグ", "型番表記", "傷や汚れ", "値札"]
};
const DEFAULT_RESHOOT_ANGLES = ["全体", "ロゴ部分", "タグ・型番表記", "傷や汚れ", "値札"];

function getReshootAngles(category) {
  const key = Object.keys(RESHOOT_ANGLES).find((k) => (category || "").includes(k));
  return key ? RESHOOT_ANGLES[key] : DEFAULT_RESHOOT_ANGLES;
}

const CONDITION_CHECKS = {
  "バッグ": ["角擦れ", "内側のベタつき", "剥がれ", "におい", "ファスナー", "ホック", "ストラップ", "金具", "付属品の有無"],
  "財布": ["角擦れ", "内側のベタつき", "剥がれ", "におい", "ファスナー", "ホック", "ストラップ", "金具", "付属品の有無"],
  "靴": ["ソールの減り", "加水分解", "ひび割れ", "サイズ", "インソール", "におい", "左右差", "箱や付属品"],
  "アウター": ["汚れ", "穴", "毛玉", "色褪せ", "におい", "サイズ", "素材", "補修跡"],
  "衣類": ["汚れ", "穴", "毛玉", "色褪せ", "におい", "サイズ", "素材", "補修跡"],
  "小物": ["傷", "汚れ", "破損", "動作(電池・可動部がある場合)", "付属品の有無"]
};
const DEFAULT_CONDITION_CHECKS = ["傷・汚れ", "におい", "動作", "付属品の有無"];

function getConditionChecks(category) {
  const key = Object.keys(CONDITION_CHECKS).find((k) => (category || "").includes(k));
  return key ? CONDITION_CHECKS[key] : DEFAULT_CONDITION_CHECKS;
}

const AUTHENTICITY_NOTICE = [
  "真贋未確認: この結果はAIによる画像解析であり、正規品であることを保証するものではありません。",
  "購入経路・刻印・型番・シリアル番号などをご自身でも確認してください。",
  "正規品と確信が持てない場合は仕入れを避けてください。",
  "高額品や真贋リスクが高いと感じる場合は、専門の鑑定サービスの利用も検討してください。"
];

// Inventory lifecycle: an item moves through these in order (skipping
// forward/back is allowed — this is a checklist of stages, not a strict
// state machine).
const ITEM_STATUSES = [
  { key: "store_reviewing", label: "店舗で確認中" },
  { key: "purchase_candidate", label: "仕入れ候補" },
  { key: "purchased", label: "購入済み" },
  { key: "listing_prep", label: "出品準備中" },
  { key: "listing_ready", label: "出品準備完了" },
  { key: "listed", label: "出品済み" },
  { key: "sold", label: "売却済み" },
  { key: "skipped", label: "見送り" }
];
const STATUS_LABEL = ITEM_STATUSES.reduce((m, s) => ((m[s.key] = s.label), m), {});

if (typeof module !== "undefined") {
  module.exports = { getReshootAngles, getConditionChecks, AUTHENTICITY_NOTICE, RESHOOT_ANGLES, CONDITION_CHECKS, ITEM_STATUSES, STATUS_LABEL };
}
