// All three stages are separate API calls with separate schemas, on
// purpose: a single call asked to "detect items AND identify brands AND
// read tags AND price them" is exactly the shape of request that produces
// confident-sounding hallucination. Splitting means stage 2/3 literally
// cannot introduce a brand/model — the schema for stage 1 has no such
// field — and stage 3b (candidate matching) only ever sees the already-
// extracted text/feature evidence from 3a, never the raw photo again, so it
// cannot invent a new "observed" detail that was never actually captured.

const DETECTION_PROMPT = [
  "あなたは中古品店の商品棚を分析する画像認識システムです。",
  "添付の写真に写っている個別の商品を、可能な限りすべて検出してください。",
  "",
  "このステージでは位置とカテゴリだけを扱います。ブランド名・商品名・型番は絶対に出力しないでください(このスキーマにはそのための項目自体がありません)。",
  "各商品について、box_2d([ymin, xmin, ymax, xmax]、0-1000に正規化した座標)、category(例: バッグ/財布/靴/アウター/衣類/小物)、visible_features(色・形状・素材の見た目など、ブランドに触れない客観的な外観描写)を出力してください。",
  "棚に写っていない商品を作り出さないでください。重なりが大きく個別に切り出せない商品は無理に分けず、まとめて1つとして扱ってください。",
  "",
  "【高く売れそうな商品の見極め(resale_interest)】",
  "ブランド名は分からなくても構いません。次のような『高値で売れそうな見た目の手がかり』が見えるかどうかだけで resale_interest(high/medium/low)を判定してください。",
  "- 値引き・クリアランスのシール、値札の割引表示が見える → discount_tag_visible を true にし、resale_interest を上げる",
  "- 革製品の自然なシボ、金具の重量感、密なステッチなど、素材や作りが上質に見える",
  "- モノグラム柄・総柄・特徴的な配色など、ブランド品によくある意匠が見える(ブランド名は言い当てない)",
  "- 未使用品らしい状態の良さ、箱・保存袋などの付属品が見える",
  "根拠が見当たらない商品は resale_interest を low にし、resale_reason に判断理由(または『特に手がかりなし』)を書いてください。存在しない手がかりを作り出さないでください。"
].join("\n");

function buildOcrPrompt(category) {
  return [
    "あなたは中古品の鑑定補助を行う画像認識システムです。添付の写真は、ユーザーが1つの商品(カテゴリ: " + (category || "不明") + ")について複数の角度から撮影したクローズアップ写真です。",
    "このステージでは「実際に見えるものの記録」だけを行い、ブランドや商品名の判断は一切しないでください(それは次のステージで行います)。",
    "",
    "【厳守事項】",
    "- 見えない文字を補完しない。かすれて読めない文字は無理に埋めず、読めた部分だけをそのまま書く。",
    "- ロゴの雰囲気だけで意味づけをしない。見えた形をそのまま記述する(例:「三本の斜め線」「馬車のマーク」など、ブランド名を決めつけずに形状のみ)。",
    "- 画像に存在しないタグや特徴を作らない。",
    "",
    "各画像について、写っている文字をそのまま(誤字も含めて)ocr_fragmentsに記録してください(image_index, raw_text, location(どこに書かれていたか), text_confidence)。",
    "visual_featuresには色・素材の見た目(material_guess)・金具の様子(hardware)・縫製の様子(stitching_quality)・アイコニックな柄や意匠が見えた場合はそのまま形状描写(iconic_pattern_observed、ブランド名で呼ばない)・その他特徴的な印(notable_marks)を記録してください。",
    "condition_notesには傷・汚れ・劣化など気づいた点を書いてください(におい等、写真から分からないことには触れないでください)。",
    "商品特定に必要な写真(ロゴ、内タグ、型番、値札など)が不足していると感じる場合は insufficient_photos を true にし、missing_angles に不足している撮影箇所を具体的に列挙してください。"
  ].join("\n");
}

function buildCandidatePrompt(category, ocrResult) {
  return [
    "あなたは中古品転売(せどり)の目利きです。以下は、ある商品(カテゴリ: " + (category || "不明") + ")について別の画像認識ステージが抽出した客観的な観察結果です。あなたは元の写真を見ることはできません。この観察結果だけを根拠に、ブランド・型番の候補を判断してください。",
    "",
    "【観察結果(JSON)】",
    JSON.stringify(ocrResult),
    "",
    "【厳守事項(違反すると誤認識の原因になります)】",
    "- 上記の観察結果に存在しない文字や特徴を、あるかのように扱わない。",
    "- デザインが似ているというだけで型番を決めない。",
    "- ブランド名と型番は別々に評価する。ブランドが分かっても型番が分かるとは限らない。",
    "- 候補は最大3件まで。各候補について supporting_evidence(観察結果のどの部分を根拠にしたか)と contradicting_evidence(矛盾する点があれば)を必ず書く。",
    "- 同一ブランド内の似たモデルを区別できない場合は、型番の確定はせず、ブランドまでの判定に留める。",
    "- 型番は、タグや刻印の文字で直接確認できた場合、または複数の独立した証拠が一致する場合のみ model_candidates に requires: 'tag_or_serial_confirmed' または 'multiple_convergent_clues' として出す。それ以外は requires: 'insufficient' とする。",
    "- exact_ocr_brand_match は、ocr_fragmentsの中にブランド名の文字列そのものが(表記ゆれの範囲内で)含まれている場合のみ true にする。iconic_pattern_match は、iconic_pattern_observed の記述がそのブランド固有の意匠として広く知られる形状と一致する場合のみ true にする。",
    "- 根拠が弱ければ無理に候補を出さず、brand_candidates / model_candidates を空配列にし、category_only_reason にカテゴリまでしか判定できない理由を書く。",
    "- AIの一般知識だけで真贋を保証しない。真贋に関わる懸念があれば warnings に書く。"
  ].join("\n");
}

const SOLD_PRICE_PROMPT = [
  "添付の画像は、メルカリの「売り切れ」検索結果一覧のスクリーンショットです。",
  "画像の中に実際に印字されている価格の数字だけを読み取って、prices配列(円、数値)に出力してください。",
  "一般的な相場の知識で数字を補ったり、見えていない価格を推測したりしないでください。文字が小さすぎる・切れている・ぼやけているなどで確信が持てない金額は含めないでください。",
  "「送料込み」等の表記や商品名は無視し、価格の数字のみを対象にしてください。販売中(まだ売れていない)の値札が混ざっている場合は含めないでください。",
  "読み取れなかった項目や除外した項目がある場合は、その理由を excluded_note に短く書いてください(なければ空文字)。"
].join("\n");

if (typeof window !== "undefined") {
  window.Prompts = { DETECTION_PROMPT, buildOcrPrompt, buildCandidatePrompt, SOLD_PRICE_PROMPT };
}
