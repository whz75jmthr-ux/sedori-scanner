// Main UI controller. Screens are rendered by replacing #screen's
// innerHTML from small template functions, wired up with addEventListener
// after each render (no framework — this stays a plain static site).
(function () {
  "use strict";

  const PROMPT_VERSION = "2026-09-08a";
  const $screen = () => document.getElementById("screen");

  const S = {
    screen: "capture",
    settings: null,
    shelf: null, // { base64, width, height }
    items: [], // { id, box_2d, category, visible_features }
    activeId: null,
    itemState: {}, // id -> { photos, ocr, candidate, level, correction, soldPrices, costs, verdict }
    evalDraft: null // when set, we're in the eval harness flow
  };

  function itemOf(id) {
    if (!S.itemState[id]) {
      S.itemState[id] = { photos: [], ocr: null, candidate: null, level: "unknown", correction: null, soldPrices: [], costs: {}, verdict: null };
    }
    return S.itemState[id];
  }

  function h(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function yen(n) {
    return "¥" + Math.round(n).toLocaleString("ja-JP");
  }

  // ---------- background-friendliness ----------
  // A web page cannot keep running once the browser/tab is actually closed
  // or the OS evicts it — there is no true background service without
  // installing a native app. What we CAN do: (a) let the in-flight network
  // call finish and tell the viewer about it even if they've switched away
  // (Notification), and (b) persist progress continuously so a reload or
  // an OS-triggered tab eviction while backgrounded doesn't lose work.
  function requestNotifyPermission() {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }
  function notify(title, body) {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    if (!document.hidden) return; // they're already looking at it — no need to interrupt
    try {
      new Notification(title, { body });
    } catch (e) {
      // Notification construction can throw in some mobile browser contexts
      // (e.g. requires a Service Worker there) — this is a nice-to-have,
      // never let it break the actual analysis flow.
    }
  }

  const SESSION_KEY = "ss.session.v1";
  function saveSession() {
    try {
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ screen: S.screen, shelf: S.shelf, items: S.items, activeId: S.activeId, itemState: S.itemState })
      );
    } catch (e) {
      // Best-effort convenience only (e.g. storage quota exceeded with large
      // photos) — losing this never blocks the actual feature.
    }
  }
  function restoreSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return false;
      const saved = JSON.parse(raw);
      Object.assign(S, saved);
      return !!S.shelf;
    } catch (e) {
      return false;
    }
  }
  function clearSession() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  }

  // ---------- boot ----------
  document.addEventListener("DOMContentLoaded", () => {
    purgeExpired();
    S.settings = getSettings();
    document.getElementById("mockBanner").hidden = !S.settings.mockMode;
    document.getElementById("settingsBtn").addEventListener("click", () => goTo("settingsScreen"));
    document.getElementById("evalBtn").addEventListener("click", () => goTo("evalScreen"));
    if (!S.settings.apiKey && !S.settings.mockMode) {
      goTo("settingsScreen", { forced: true });
      return;
    }
    const resumed = restoreSession();
    goTo(resumed ? S.screen : "capture");
  });

  const STEP_ORDER = [
    ["capture", "撮影"],
    ["detect", "検出"],
    ["reshoot", "追加撮影"],
    ["analysis", "判定"],
    ["market", "相場"],
    ["costs", "費用"],
    ["verdict", "結果"]
  ];

  function renderStepsNav() {
    const nav = document.getElementById("stepsNav");
    const idx = STEP_ORDER.findIndex((s) => s[0] === S.screen);
    if (idx === -1) {
      nav.innerHTML = "";
      return;
    }
    nav.innerHTML = STEP_ORDER.map(([key, label], i) => {
      const cls = i === idx ? "active" : i < idx ? "done" : "";
      return '<span class="dot ' + cls + '">' + (i + 1) + " " + label + "</span>";
    }).join("");
  }

  function goTo(screen, opts) {
    S.screen = screen;
    renderStepsNav();
    const renderers = {
      capture: renderCapture,
      detect: renderDetect,
      reshoot: renderReshoot,
      analysis: renderAnalysis,
      market: renderMarket,
      costs: renderCosts,
      verdict: renderVerdict,
      settingsScreen: renderSettings,
      evalScreen: renderEval
    };
    ($screen()).innerHTML = "";
    $screen().appendChild(renderers[screen](opts || {}));
    saveSession();
  }

  // ---------- 1. capture ----------
  function renderCapture() {
    const root = h('<div></div>');
    root.appendChild(
      h(
        '<section class="panel">' +
          "<h2>商品棚を撮影</h2>" +
          '<p class="desc">中古品店の商品棚を1枚撮影してください。まず「どこに何があるか」を検出し、気になる商品だけ後で個別に撮り直します。</p>' +
          '<div id="dz" class="dropzone" role="button" tabindex="0"><span class="icon">📷</span><span class="cta">棚を撮る / 画像を選ぶ</span><div class="hint">複数商品が写っていてOKです</div></div>' +
          '<input type="file" id="shelfInput" accept="image/*" capture="environment" hidden>' +
          '<p class="status-line" id="captureStatus" hidden></p>' +
          "</section>"
      )
    );
    const dz = root.querySelector("#dz");
    const input = root.querySelector("#shelfInput");
    dz.addEventListener("click", () => input.click());
    dz.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const statusEl = root.querySelector("#captureStatus");
      statusEl.hidden = false;
      statusEl.textContent = "画像を準備中…";
      const resized = await GeminiClient.resizeToBase64(file, 2048, 0.92);
      S.shelf = resized;
      await runDetection(statusEl);
    });
    return root;
  }

  async function runDetection(statusEl) {
    requestNotifyPermission();
    try {
      statusEl.textContent = "商品を検出中…(数十秒かかることがあります。画面を離れても終わったら通知します)";
      const schema = DETECTION_SCHEMA;
      const result = await GeminiClient.callWithValidation({
        apiKey: S.settings.apiKey,
        model: S.settings.model,
        promptText: Prompts.DETECTION_PROMPT,
        images: [S.shelf],
        schema,
        validate: validateAgainstSchema,
        mock: S.settings.mockMode ? MockData.MOCK_DETECTION : null
      });
      S.items = (result.items || []).map((it, i) => ({
        id: "item" + (i + 1),
        num: i + 1,
        box_2d: it.box_2d,
        category: it.category,
        visible_features: it.visible_features,
        resaleInterest: ["high", "medium", "low"].includes(it.resale_interest) ? it.resale_interest : "low",
        resaleReason: it.resale_reason || "",
        discountTagVisible: !!it.discount_tag_visible
      }));
      if (S.items.length === 0) {
        statusEl.className = "status-line";
        statusEl.textContent = "商品を検出できませんでした。別の角度で撮り直してみてください。";
        notify("商品を検出できませんでした", "別の角度でもう一度撮影してみてください。");
        return;
      }
      const highCount = S.items.filter((it) => it.resaleInterest === "high").length;
      notify("商品検出が完了しました", S.items.length + "件検出(狙い目度の高いもの" + highCount + "件)。アプリに戻って確認してください。");
      goTo("detect");
    } catch (err) {
      console.error(err);
      const fe = GeminiClient.friendlyError(err);
      statusEl.className = "status-line err";
      statusEl.textContent = fe.message;
      notify("解析に失敗しました", fe.message);
    }
  }

  // ---------- 2. detect ----------
  function renderDetect() {
    const root = h('<div></div>');
    const boxesSvg = S.items
      .map((it) => {
        const [ymin, xmin, ymax, xmax] = it.box_2d;
        const labelY = Math.max(18, ymin - 4);
        return (
          '<rect x="' + xmin + '" y="' + ymin + '" width="' + (xmax - xmin) + '" height="' + (ymax - ymin) + '" fill="none" stroke="#E3A63E" stroke-width="6" />' +
          '<circle cx="' + (xmin + 16) + '" cy="' + (labelY - 12) + '" r="18" fill="#E3A63E" />' +
          '<text x="' + (xmin + 16) + '" y="' + labelY + '" fill="#191203" font-size="26" font-weight="700" text-anchor="middle" class="box-num">' + it.num + "</text>"
        );
      })
      .join("");
    const highCount = S.items.filter((it) => it.resaleInterest === "high").length;
    root.appendChild(
      h(
        '<section class="panel">' +
          "<h2>検出された商品</h2>" +
          '<p class="desc">気になる商品の番号をタップすると、その商品だけ追加撮影して詳しく判定できます。この段階ではカテゴリと外観だけで、ブランドはまだ判定していません。</p>' +
          (highCount > 0
            ? '<div class="banner info">💰 見た目の手がかり(値引き表示・素材の良さなど)から、狙い目度の高い商品が' + highCount + "件あります。下のリストで上位に表示しています。</div>"
            : '<div class="banner">今回の写真では、ブランド以外の強い手がかり(値引き表示など)は見当たりませんでした。気になる商品があれば個別に確認してください。</div>') +
          '<div class="shelf-wrap"><img src="data:image/jpeg;base64,' + S.shelf.base64 + '" alt="撮影した商品棚"><svg viewBox="0 0 1000 1000" preserveAspectRatio="none">' + boxesSvg + "</svg></div>" +
          '<div class="item-list" id="itemList"></div>' +
          '<div class="actions"><button class="btn" id="retakeShelf">棚を撮り直す</button></div>' +
          "</section>"
      )
    );
    const list = root.querySelector("#itemList");
    const interestRank = { high: 2, medium: 1, low: 0 };
    const sorted = S.items.slice().sort((a, b) => (interestRank[b.resaleInterest] || 0) - (interestRank[a.resaleInterest] || 0));
    const interestLabel = { high: "狙い目度: 高", medium: "狙い目度: 中", low: "狙い目度: 低" };
    sorted.forEach((it) => {
      const row = h(
        '<button type="button" class="item-row"><span class="num">' +
          it.num +
          '</span><span class="label"><div class="cat">' +
          escapeHtml(it.category) +
          ' <span class="badge ' +
          (it.resaleInterest === "high" ? "confirmed" : it.resaleInterest === "medium" ? "candidate" : "unknown") +
          '" style="margin-left:6px;">' +
          interestLabel[it.resaleInterest] +
          (it.discountTagVisible ? " 🏷️値引きあり" : "") +
          "</span></div>" +
          '<div class="feat">' +
          escapeHtml(it.visible_features) +
          (it.resaleReason ? " — " + escapeHtml(it.resaleReason) : "") +
          "</div></span></button>"
      );
      row.addEventListener("click", () => {
        S.activeId = it.id;
        goTo("reshoot");
      });
      list.appendChild(row);
    });
    root.querySelector("#retakeShelf").addEventListener("click", () => {
      S.shelf = null;
      S.items = [];
      S.itemState = {};
      S.activeId = null;
      clearSession();
      goTo("capture");
    });
    return root;
  }

  // ---------- 3. reshoot ----------
  function renderReshoot() {
    const item = S.items.find((i) => i.id === S.activeId);
    const state = itemOf(S.activeId);
    const angles = getReshootAngles(item.category);
    const root = h('<div></div>');
    root.appendChild(
      h(
        '<section class="panel">' +
          "<h2>" + escapeHtml(item.category) + "を追加撮影</h2>" +
          '<p class="desc">' + escapeHtml(item.visible_features) + "</p>" +
          "<h3>撮っておきたい箇所</h3>" +
          '<ul class="checklist">' +
          angles.map((a) => '<li><input type="checkbox">' + escapeHtml(a) + "</li>").join("") +
          "</ul>" +
          '<div class="dropzone" id="dz2" role="button" tabindex="0" style="margin-top:14px;"><span class="icon">📷</span><span class="cta">写真を追加する(複数可)</span></div>' +
          '<input type="file" id="itemInput" accept="image/*" capture="environment" multiple hidden>' +
          '<div class="thumb-row" id="thumbRow"></div>' +
          '<p class="status-line" id="reshootStatus" hidden></p>' +
          '<div class="actions"><button class="btn btn-primary" id="analyzeItemBtn" disabled>この写真で判定する</button><button class="btn" id="backToDetect">商品一覧に戻る</button></div>' +
          "</section>"
      )
    );
    const thumbRow = root.querySelector("#thumbRow");
    function renderThumbs() {
      thumbRow.innerHTML = state.photos.map((p) => '<img src="data:image/jpeg;base64,' + p.base64 + '">').join("");
      root.querySelector("#analyzeItemBtn").disabled = state.photos.length === 0;
    }
    renderThumbs();
    const dz2 = root.querySelector("#dz2");
    const itemInput = root.querySelector("#itemInput");
    dz2.addEventListener("click", () => itemInput.click());
    itemInput.addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      for (const f of files) {
        const resized = await GeminiClient.resizeToBase64(f, 2048, 0.92);
        state.photos.push(resized);
      }
      renderThumbs();
    });
    root.querySelector("#backToDetect").addEventListener("click", () => goTo("detect"));
    root.querySelector("#analyzeItemBtn").addEventListener("click", () => runAnalysis(root.querySelector("#reshootStatus")));
    return root;
  }

  // ---------- 3b/3c: OCR then candidate calls, then -> analysis screen ----------
  async function runAnalysis(statusEl) {
    const item = S.items.find((i) => i.id === S.activeId);
    const state = itemOf(S.activeId);
    statusEl.hidden = false;
    statusEl.className = "status-line";
    requestNotifyPermission();
    try {
      statusEl.textContent = "文字・特徴を読み取り中…";
      const ocr = await GeminiClient.callWithValidation({
        apiKey: S.settings.apiKey,
        model: S.settings.model,
        promptText: Prompts.buildOcrPrompt(item.category),
        images: state.photos,
        schema: OCR_SCHEMA,
        validate: validateAgainstSchema,
        mock: S.settings.mockMode ? MockData.MOCK_OCR : null
      });
      state.ocr = ocr;

      statusEl.textContent = "ブランド・型番の候補を照合中…";
      const candidate = await GeminiClient.callWithValidation({
        apiKey: S.settings.apiKey,
        model: S.settings.model,
        promptText: Prompts.buildCandidatePrompt(item.category, ocr),
        images: [], // deliberately no images: candidate matching only sees stage-3a's structured text output
        schema: CANDIDATE_SCHEMA,
        validate: validateAgainstSchema,
        mock: S.settings.mockMode ? MockData.MOCK_CANDIDATE : null
      });
      state.candidate = candidate;
      state.level = computeIdentificationLevel(candidate, ocr);
      notify("判定が完了しました", escapeHtml(item.category) + "の判定結果: " + LEVEL_LABEL[state.level] + "。アプリに戻って確認してください。");
      goTo("analysis");
    } catch (err) {
      console.error(err);
      const fe = GeminiClient.friendlyError(err);
      statusEl.className = "status-line err";
      statusEl.textContent = fe.message;
      notify("解析に失敗しました", fe.message);
    }
  }

  // ---------- 4. analysis ----------
  function renderAnalysis() {
    const item = S.items.find((i) => i.id === S.activeId);
    const state = itemOf(S.activeId);
    const ocr = state.ocr;
    const cand = state.candidate;
    const level = state.level;
    const root = h('<div></div>');

    const needsMorePhotos = level === "unknown" && ocr && ocr.insufficient_photos;

    let body = '<section class="panel">';
    body += '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;"><h2>判定結果</h2><span class="badge ' + level + '">' + LEVEL_LABEL[level] + "</span></div>";
    body += '<p class="desc">' + escapeHtml(item.category) + " ／ " + escapeHtml(item.visible_features) + "</p>";

    if (needsMorePhotos || (ocr && ocr.missing_angles && ocr.missing_angles.length)) {
      body +=
        '<div class="banner warn">📸 追加撮影が必要です: ' +
        escapeHtml((ocr.missing_angles || []).join("、") || "ロゴ・タグ・型番がはっきり写る写真") +
        "</div>";
    }

    if (level === "unknown" && !needsMorePhotos) {
      body += '<div class="banner warn">この写真だけでは判定できません。「不明」は正常な結果です — 推測でブランド名を表示することはしません。</div>';
    }

    // brand candidates
    if (cand && cand.brand_candidates && cand.brand_candidates.length) {
      body += "<h3>ブランド候補</h3>";
      cand.brand_candidates.forEach((b) => {
        body +=
          '<div class="evidence-block"><div class="k">' +
          (b.based_on === "exact_text_match" ? "文字が一致" : b.based_on === "iconic_pattern" ? "意匠が一致" : "部分的な一致") +
          '</div><strong style="font-size:15px;">' +
          escapeHtml(b.brand) +
          "</strong>" +
          (b.supporting_evidence.length ? "<ul>" + b.supporting_evidence.map((e) => "<li>" + escapeHtml(e) + "</li>").join("") + "</ul>" : "") +
          (b.contradicting_evidence.length ? '<div class="k" style="margin-top:6px;color:var(--danger);">矛盾する点</div><ul>' + b.contradicting_evidence.map((e) => "<li>" + escapeHtml(e) + "</li>").join("") + "</ul>" : "") +
          "</div>";
      });
    } else if (cand && cand.category_only_reason) {
      body += '<div class="banner">ブランド判定は保留: ' + escapeHtml(cand.category_only_reason) + "</div>";
    }

    if (cand && cand.model_candidates && cand.model_candidates.length) {
      body += "<h3>型番候補</h3>";
      cand.model_candidates.forEach((m) => {
        body +=
          '<div class="evidence-block"><div class="k">' +
          (m.requires === "tag_or_serial_confirmed" ? "タグ・刻印で確認" : m.requires === "multiple_convergent_clues" ? "複数の一致証拠" : "根拠不足") +
          '</div><strong style="font-size:15px;">' +
          escapeHtml(m.model) +
          "</strong>" +
          (m.supporting_evidence.length ? "<ul>" + m.supporting_evidence.map((e) => "<li>" + escapeHtml(e) + "</li>").join("") + "</ul>" : "") +
          "</div>";
      });
    }

    if (ocr) {
      body += "<h3>読み取った文字(OCR原文)</h3>";
      if (ocr.ocr_fragments.length) {
        body +=
          '<div class="evidence-block"><ul>' +
          ocr.ocr_fragments.map((f) => "<li>「" + escapeHtml(f.raw_text) + "」— " + escapeHtml(f.location) + " (信頼度: " + escapeHtml(f.text_confidence) + ")</li>").join("") +
          "</ul></div>";
      } else {
        body += '<div class="evidence-block">読み取れる文字はありませんでした。</div>';
      }
      body +=
        '<div class="evidence-block"><div class="k">素材・作り</div>' +
        escapeHtml(ocr.visual_features.material_guess) +
        " / " +
        escapeHtml(ocr.visual_features.hardware) +
        " / " +
        escapeHtml(ocr.visual_features.stitching_quality) +
        (ocr.condition_notes ? '<div class="k" style="margin-top:8px;">状態メモ</div>' + escapeHtml(ocr.condition_notes) : "") +
        "</div>";
    }

    if (cand && cand.warnings && cand.warnings.length) {
      body += '<div class="banner warn">' + cand.warnings.map(escapeHtml).join(" / ") + "</div>";
    }

    if (level !== "unknown" || (cand && cand.brand_candidates.length)) {
      body += '<div class="banner warn">' + AUTHENTICITY_NOTICE.join(" ") + "</div>";
    }

    body += "<h3>状態チェック(現物確認が必要)</h3>";
    body +=
      '<ul class="checklist">' +
      getConditionChecks(item.category)
        .map((c) => "<li><input type=\"checkbox\">" + escapeHtml(c) + "</li>")
        .join("") +
      "</ul>";
    body += '<p class="field-hint">写真だけでは、におい・動作・内部の劣化は判定できません。購入前に必ず現物を確認してください。</p>';

    body += "<h3>訂正</h3>";
    body += '<p class="field-hint">AIの判定が違う場合はここで訂正できます。訂正内容は今後の改善のためこの端末に保存され、外部には送信されません。</p>';
    const corr = state.correction || {};
    body +=
      '<div class="field-row"><label class="field-label">正しいブランド</label><input type="text" id="corrBrand" value="' + escapeHtml(corr.brand || "") + '" placeholder="不明なら空欄のまま"></div>' +
      '<div class="field-row"><label class="field-label">正しい型番</label><input type="text" id="corrModel" value="' + escapeHtml(corr.model || "") + '" placeholder="不明なら空欄のまま"></div>' +
      '<div class="field-row"><label class="field-label">訂正理由・メモ</label><textarea id="corrNote">' + escapeHtml(corr.note || "") + "</textarea></div>" +
      '<button class="btn btn-sm" id="saveCorrection">訂正を保存</button>' +
      '<p class="status-line" id="corrStatus" hidden></p>';

    body += '<div class="actions"><button class="btn" id="reshootMore">追加で撮り直す</button><button class="btn btn-primary" id="toMarket">次へ(メルカリ相場)</button></div>';
    body += "</section>";

    root.appendChild(h(body));
    root.querySelector("#reshootMore").addEventListener("click", () => goTo("reshoot"));
    root.querySelector("#toMarket").addEventListener("click", () => goTo("market"));
    root.querySelector("#saveCorrection").addEventListener("click", () => {
      const brand = root.querySelector("#corrBrand").value.trim();
      const model = root.querySelector("#corrModel").value.trim();
      const note = root.querySelector("#corrNote").value.trim();
      state.correction = { brand, model, note };
      addCorrection({
        category: item.category,
        aiBrandCandidates: (cand && cand.brand_candidates) || [],
        aiModelCandidates: (cand && cand.model_candidates) || [],
        aiIdentificationLevel: level,
        ocrFragments: (ocr && ocr.ocr_fragments) || [],
        userBrand: brand,
        userModel: model,
        userNote: note,
        photoCount: state.photos.length,
        model_name: S.settings.model,
        promptVersion: PROMPT_VERSION
      });
      const statusEl = root.querySelector("#corrStatus");
      statusEl.hidden = false;
      statusEl.className = "status-line ok";
      statusEl.textContent = "保存しました。";
    });
    return root;
  }

  // ---------- 5. market ----------
  function renderMarket() {
    const item = S.items.find((i) => i.id === S.activeId);
    const state = itemOf(S.activeId);
    const cand = state.candidate;
    const corr = state.correction || {};
    const keywordParts = [corr.brand || (cand && cand.brand_candidates[0] && cand.brand_candidates[0].brand) || "", corr.model || "", item.category].filter(Boolean);
    const keyword = keywordParts.join(" ") || item.visible_features;
    const url = "https://jp.mercari.com/search?keyword=" + encodeURIComponent(keyword) + "&status=sold_out";

    const root = h(
      '<section class="panel">' +
        "<h2>メルカリ相場</h2>" +
        '<p class="desc">販売中の価格ではなく「売り切れ」実績を基準にします。他サイトの希望価格も混ぜないでください。同じブランド・型番・カテゴリ・サイズ・近い状態のものを、可能なら5〜10件集めてください。</p>' +
        '<a class="mercari-link" href="' + url + '" target="_blank" rel="noopener">🔍 「' + escapeHtml(keyword) + '」の売り切れをメルカリで見る →</a>' +
        '<h3 style="margin-top:16px;">見つけた売り切れ価格を入力</h3>' +
        '<div class="price-list" id="priceList"></div>' +
        '<button class="btn btn-sm" id="addPrice">+ 価格を追加</button>' +
        '<p class="status-line" id="marketSummary"></p>' +
        '<div class="actions"><button class="btn" id="backToAnalysis">判定に戻る</button><button class="btn btn-primary" id="toCosts">次へ(費用)</button></div>' +
        "</section>"
    );
    const priceList = root.querySelector("#priceList");
    function renderPrices() {
      priceList.innerHTML = "";
      state.soldPrices.forEach((val, i) => {
        const row = h('<div class="row"><input type="number" inputmode="numeric" placeholder="例: 4500" value="' + (val || "") + '"><button class="btn btn-sm" type="button">×</button></div>');
        row.querySelector("input").addEventListener("input", (e) => {
          state.soldPrices[i] = Number(e.target.value) || 0;
          updateSummary();
        });
        row.querySelector("button").addEventListener("click", () => {
          state.soldPrices.splice(i, 1);
          renderPrices();
          updateSummary();
        });
        priceList.appendChild(row);
      });
    }
    function updateSummary() {
      const summary = summarizeSoldPrices(state.soldPrices);
      state.marketSummary = summary;
      const el = root.querySelector("#marketSummary");
      if (!summary.sufficient) {
        el.className = "status-line";
        el.textContent = "あと" + Math.max(0, MIN_SAMPLES_FOR_ESTIMATE - summary.count) + "件以上入力すると相場を計算します(現在" + summary.count + "件、参考値のみ表示可)。";
      } else {
        el.className = "status-line ok";
        el.textContent =
          "件数: " + summary.count + "件(外れ値" + summary.trimmedCount + "件除外) / 中央値: " + yen(summary.median) + " / 範囲: " + yen(summary.low) + "〜" + yen(summary.high);
      }
    }
    if (state.soldPrices.length === 0) state.soldPrices.push(0);
    renderPrices();
    updateSummary();
    root.querySelector("#addPrice").addEventListener("click", () => {
      state.soldPrices.push(0);
      renderPrices();
      updateSummary();
    });
    root.querySelector("#backToAnalysis").addEventListener("click", () => goTo("analysis"));
    root.querySelector("#toCosts").addEventListener("click", () => goTo("costs"));
    return root;
  }

  // ---------- 6. costs ----------
  function renderCosts() {
    const state = itemOf(S.activeId);
    const c = Object.assign(
      {
        purchasePrice: 0,
        feeRatePercent: S.settings.feeRatePercent,
        shippingCost: S.settings.defaultShippingCost,
        packagingCost: S.settings.defaultPackagingCost,
        repairCost: S.settings.defaultRepairCost
      },
      state.costs
    );
    const root = h(
      '<section class="panel">' +
        "<h2>費用を入力</h2>" +
        '<div class="field-grid">' +
        '<div class="field-row"><label class="field-label">仕入価格(円)</label><input type="number" id="cPurchase" value="' + c.purchasePrice + '"></div>' +
        '<div class="field-row"><label class="field-label">販売手数料(%)</label><input type="number" id="cFee" value="' + c.feeRatePercent + '"></div>' +
        '<div class="field-row"><label class="field-label">送料(円)</label><input type="number" id="cShip" value="' + c.shippingCost + '"></div>' +
        '<div class="field-row"><label class="field-label">梱包費(円)</label><input type="number" id="cPack" value="' + c.packagingCost + '"></div>' +
        '<div class="field-row"><label class="field-label">手入れ費(円)</label><input type="number" id="cRepair" value="' + c.repairCost + '"></div>' +
        "</div>" +
        '<div class="kv-table" id="livePreview"></div>' +
        '<div class="actions"><button class="btn" id="backToMarket">相場に戻る</button><button class="btn btn-primary" id="toVerdict">判定する</button></div>' +
        "</section>"
    );
    function readCosts() {
      return {
        purchasePrice: Number(root.querySelector("#cPurchase").value) || 0,
        feeRatePercent: Number(root.querySelector("#cFee").value) || 0,
        shippingCost: Number(root.querySelector("#cShip").value) || 0,
        packagingCost: Number(root.querySelector("#cPack").value) || 0,
        repairCost: Number(root.querySelector("#cRepair").value) || 0
      };
    }
    function updatePreview() {
      const cc = readCosts();
      state.costs = cc;
      const summary = state.marketSummary;
      const preview = root.querySelector("#livePreview");
      if (!summary || !summary.sufficient) {
        preview.innerHTML = "<tr><td colspan=2>相場データが不足しているため、利益はまだ計算できません。</td></tr>";
        return;
      }
      const r = calculateProfit({
        salePrice: summary.median,
        feeRate: cc.feeRatePercent / 100,
        shippingCost: cc.shippingCost,
        purchasePrice: cc.purchasePrice,
        packagingCost: cc.packagingCost,
        repairCost: cc.repairCost
      });
      preview.innerHTML =
        "<tr><td>想定販売価格(中央値)</td><td>" + yen(summary.median) + "</td></tr>" +
        "<tr><td>手数料</td><td>" + yen(r.fee) + "</td></tr>" +
        '<tr class="total"><td>予想利益</td><td>' + yen(r.profit) + "</td></tr>";
    }
    ["#cPurchase", "#cFee", "#cShip", "#cPack", "#cRepair"].forEach((sel) => root.querySelector(sel).addEventListener("input", updatePreview));
    updatePreview();
    root.querySelector("#backToMarket").addEventListener("click", () => goTo("market"));
    root.querySelector("#toVerdict").addEventListener("click", () => {
      state.costs = readCosts();
      goTo("verdict");
    });
    return root;
  }

  // ---------- 7. verdict ----------
  function renderVerdict() {
    const item = S.items.find((i) => i.id === S.activeId);
    const state = itemOf(S.activeId);
    const summary = state.marketSummary || { sufficient: false, count: (state.soldPrices || []).filter(Boolean).length };
    const c = state.costs || {};
    const conditionFlagged = false; // condition checklist is informational; we don't auto-flag from checkboxes in this version
    let profit = 0;
    let breakEven = null;
    if (summary.sufficient) {
      const r = calculateProfit({
        salePrice: summary.median,
        feeRate: (c.feeRatePercent || 0) / 100,
        shippingCost: c.shippingCost || 0,
        purchasePrice: c.purchasePrice || 0,
        packagingCost: c.packagingCost || 0,
        repairCost: c.repairCost || 0
      });
      profit = r.profit;
      breakEven = r.breakEvenPurchasePrice;
    }
    const v = decideVerdict({
      identificationLevel: state.level,
      soldSummary: summary,
      profit,
      targetProfitMin: S.settings.targetProfitMin,
      targetProfitMax: S.settings.targetProfitMax,
      conditionFlagged
    });
    const verdictClass = v.verdict === "仕入れ候補" ? "verdict-buy" : v.verdict === "見送り" ? "verdict-skip" : "verdict-check";
    const safeMaxPurchase = summary.sufficient
      ? summary.median - summary.median * ((c.feeRatePercent || 0) / 100) - (c.shippingCost || 0) - (c.packagingCost || 0) - (c.repairCost || 0) - S.settings.targetProfitMin
      : null;

    const root = h(
      '<section class="panel verdict-card">' +
        '<span class="badge ' + verdictClass + '" style="font-size:14px;padding:6px 16px;">' + escapeHtml(v.verdict) + "</span>" +
        '<div class="big">' + escapeHtml(item.category) + (state.correction && state.correction.brand ? " / " + escapeHtml(state.correction.brand) : "") + "</div>" +
        (summary.sufficient ? '<div class="profit">' + yen(profit) + "</div><p class=\"field-hint\">予想利益</p>" : '<p class="field-hint">相場データ不足のため利益は未算出です</p>') +
        (v.reasons.length ? '<div class="banner warn" style="text-align:left;">' + v.reasons.map(escapeHtml).join(" / ") + "</div>" : "") +
        '<table class="kv-table" style="text-align:left;margin-top:14px;">' +
        "<tr><td>判定レベル</td><td>" + LEVEL_LABEL[state.level] + "</td></tr>" +
        "<tr><td>売り切れ比較件数</td><td>" + summary.count + "件</td></tr>" +
        (summary.sufficient ? "<tr><td>販売価格の範囲</td><td>" + yen(summary.low) + "〜" + yen(summary.high) + "</td></tr>" : "") +
        (breakEven !== null ? "<tr><td>損益分岐の仕入価格</td><td>" + yen(breakEven) + "</td></tr>" : "") +
        (safeMaxPurchase !== null ? "<tr><td>安全な仕入れ上限(目標利益込み)</td><td>" + yen(safeMaxPurchase) + "</td></tr>" : "") +
        "<tr><td>判定日時</td><td>" + new Date().toLocaleString("ja-JP") + "</td></tr>" +
        "</table>" +
        '<div class="actions" style="justify-content:center;"><button class="btn" id="backToCosts">費用に戻る</button><button class="btn" id="anotherItem">別の商品を見る</button><button class="btn btn-primary" id="recordEval">評価用に記録</button></div>' +
        "</section>"
    );
    root.querySelector("#backToCosts").addEventListener("click", () => goTo("costs"));
    root.querySelector("#anotherItem").addEventListener("click", () => goTo("detect"));
    root.querySelector("#recordEval").addEventListener("click", () => {
      addEvalRecord({
        kind: "in_app_verdict",
        category: item.category,
        identificationLevel: state.level,
        verdict: v.verdict,
        aiBrandCandidates: (state.candidate && state.candidate.brand_candidates) || [],
        userBrand: (state.correction && state.correction.brand) || null,
        promptVersion: PROMPT_VERSION,
        modelName: S.settings.model
      });
      alert("精度検証用データとして記録しました。設定画面の📊から確認できます。");
    });
    return root;
  }

  // ---------- settings ----------
  function renderSettings(opts) {
    const s = S.settings;
    const corrections = listCorrections();
    const evalRecords = listEvalRecords();
    const root = h(
      '<section class="panel">' +
        "<h2>設定</h2>" +
        (opts.forced ? '<div class="banner warn">利用を始めるにはAPIキーが必要です(モックモードならキーなしで画面を試せます)。</div>' : "") +
        '<div class="field-row"><label class="field-label">Gemini APIキー</label><input type="password" id="sKey" value="' + escapeHtml(s.apiKey) + '" placeholder="AIza..."></div>' +
        '<p class="field-hint"><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Google AI Studio でキーを発行する →</a></p>' +
        '<div class="field-row"><label class="field-label">モデル名</label><input type="text" id="sModel" value="' + escapeHtml(s.model) + '"></div>' +
        '<div class="field-row"><label class="field-label"><input type="checkbox" id="sMock" ' + (s.mockMode ? "checked" : "") + "> モックモード(実際のAI呼び出しをせず、テスト用の固定結果を使う)</label></div>" +
        "<h3>費用のデフォルト値</h3>" +
        '<div class="field-grid">' +
        '<div class="field-row"><label class="field-label">販売手数料(%)</label><input type="number" id="sFee" value="' + s.feeRatePercent + '"></div>' +
        '<div class="field-row"><label class="field-label">送料(円)</label><input type="number" id="sShip" value="' + s.defaultShippingCost + '"></div>' +
        '<div class="field-row"><label class="field-label">梱包費(円)</label><input type="number" id="sPack" value="' + s.defaultPackagingCost + '"></div>' +
        '<div class="field-row"><label class="field-label">手入れ費(円)</label><input type="number" id="sRepair" value="' + s.defaultRepairCost + '"></div>' +
        '<div class="field-row"><label class="field-label">目標利益 下限(円)</label><input type="number" id="sMin" value="' + s.targetProfitMin + '"></div>' +
        '<div class="field-row"><label class="field-label">目標利益 上限(円)</label><input type="number" id="sMax" value="' + s.targetProfitMax + '"></div>' +
        "</div>" +
        '<div class="field-row"><label class="field-label">ローカルデータの保存日数</label><input type="number" id="sRetention" value="' + s.retentionDays + '"></div>' +
        '<button class="btn btn-primary" id="saveSettings">保存する</button>' +
        '<p class="status-line" id="settingsStatus" hidden></p>' +
        "<h3>保存されているデータ(この端末のみ)</h3>" +
        "<p>訂正データ: " + corrections.length + "件 / 評価記録: " + evalRecords.length + "件</p>" +
        '<div class="actions"><button class="btn btn-sm" id="exportData">JSONでエクスポート</button><button class="btn btn-sm btn-danger" id="wipeData">全データ削除</button></div>' +
        '<p class="field-hint">これらのデータはこの端末のブラウザにのみ保存され、あなたの許可なく外部へ送信されることはありません。</p>' +
        "</section>"
    );
    root.querySelector("#saveSettings").addEventListener("click", () => {
      S.settings = saveSettings({
        apiKey: root.querySelector("#sKey").value.trim(),
        model: root.querySelector("#sModel").value.trim() || DEFAULT_SETTINGS.model,
        mockMode: root.querySelector("#sMock").checked,
        feeRatePercent: Number(root.querySelector("#sFee").value) || 0,
        defaultShippingCost: Number(root.querySelector("#sShip").value) || 0,
        defaultPackagingCost: Number(root.querySelector("#sPack").value) || 0,
        defaultRepairCost: Number(root.querySelector("#sRepair").value) || 0,
        targetProfitMin: Number(root.querySelector("#sMin").value) || 0,
        targetProfitMax: Number(root.querySelector("#sMax").value) || 0,
        retentionDays: Number(root.querySelector("#sRetention").value) || 30
      });
      document.getElementById("mockBanner").hidden = !S.settings.mockMode;
      const statusEl = root.querySelector("#settingsStatus");
      statusEl.hidden = false;
      statusEl.className = "status-line ok";
      statusEl.textContent = "保存しました。";
      if (opts.forced && (S.settings.apiKey || S.settings.mockMode)) {
        setTimeout(() => goTo("capture"), 400);
      }
    });
    root.querySelector("#exportData").addEventListener("click", () => {
      const data = { corrections: listCorrections(), evalRecords: listEvalRecords(), exportedAt: new Date().toISOString() };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "sedori-scanner-export-" + Date.now() + ".json";
      a.click();
    });
    root.querySelector("#wipeData").addEventListener("click", () => {
      if (confirm("訂正データ・評価記録をすべて削除します。よろしいですか?")) {
        wipeAllLocalData();
        goTo("settingsScreen");
      }
    });
    return root;
  }

  // ---------- eval harness ----------
  function renderEval() {
    const records = listEvalRecords();
    const total = records.length;
    const withUserBrand = records.filter((r) => r.userBrand);
    const top1 = withUserBrand.filter((r) => r.aiBrandCandidates && r.aiBrandCandidates[0] && r.aiBrandCandidates[0].brand === r.userBrand).length;
    const top3 = withUserBrand.filter((r) => r.aiBrandCandidates && r.aiBrandCandidates.some((c) => c.brand === r.userBrand)).length;
    const confidentlyWrong = records.filter((r) => r.identificationLevel === "confirmed" && r.userBrand && !(r.aiBrandCandidates || []).some((c) => c.brand === r.userBrand)).length;

    const root = h(
      '<section class="panel">' +
        "<h2>精度テスト(この端末のログから集計)</h2>" +
        (total === 0
          ? '<div class="banner">まだ記録がありません。判定結果画面の「評価用に記録」を使うとここに集計されます。ラベル付きテスト画像を使った本格的な精度測定はまだ実施していません — 数値は未計測です。</div>'
          : '<div class="kv-table" style="margin-bottom:16px;"><tr><td>記録件数</td><td>' +
            total +
            "件</td></tr><tr><td>ブランドTop-1一致率</td><td>" +
            (withUserBrand.length ? Math.round((top1 / withUserBrand.length) * 100) + "% (" + top1 + "/" + withUserBrand.length + ")" : "未計測") +
            "</td></tr><tr><td>ブランドTop-3一致率</td><td>" +
            (withUserBrand.length ? Math.round((top3 / withUserBrand.length) * 100) + "% (" + top3 + "/" + withUserBrand.length + ")" : "未計測") +
            '</td></tr><tr><td style="color:var(--danger);">確認済み表示なのに誤り(最重要)</td><td>' +
            confidentlyWrong +
            "件</td></tr></table>") +
        '<div class="scroll-x"><table class="eval-table"><tr><th>日時</th><th>カテゴリ</th><th>判定レベル</th><th>AI候補</th><th>ユーザー訂正</th></tr>' +
        records
          .slice()
          .reverse()
          .map(
            (r) =>
              "<tr><td>" +
              new Date(r.savedAt).toLocaleString("ja-JP") +
              "</td><td>" +
              escapeHtml(r.category || "") +
              "</td><td>" +
              escapeHtml(LEVEL_LABEL[r.aiIdentificationLevel || r.identificationLevel] || "") +
              "</td><td>" +
              escapeHtml((r.aiBrandCandidates || []).map((c) => c.brand).join(", ")) +
              "</td><td>" +
              escapeHtml(r.userBrand || "") +
              "</td></tr>"
          )
          .join("") +
        "</table></div>" +
        '<div class="actions"><button class="btn btn-sm" id="clearEval">評価記録を削除</button></div>' +
        "</section>"
    );
    root.querySelector("#clearEval").addEventListener("click", () => {
      if (confirm("評価記録を削除します。よろしいですか?")) {
        clearEvalRecords();
        goTo("evalScreen");
      }
    });
    return root;
  }
})();
