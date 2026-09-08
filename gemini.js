// All calls to Google's Gemini Interactions API go through here.
//
// Endpoint, auth header, request/response shape were confirmed against the
// live official docs on 2026-09-08 (ai.google.dev/api/interactions-api,
// ai.google.dev/gemini-api/docs/get-started, .../structured-output,
// .../image-understanding) — not written from memory, per the requirement
// that external API shapes must be checked at implementation time.
//   POST https://generativelanguage.googleapis.com/v1beta/interactions
//   header: x-goog-api-key
//   body: { model, input: [{type:'text'|'image', ...}], response_format }
//   bounding boxes: box_2d = [ymin, xmin, ymax, xmax] normalized to 0-1000.

const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

function resizeToBase64(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxSide) {
        height = Math.round((height * maxSide) / width);
        width = maxSide;
      } else if (height > maxSide) {
        width = Math.round((width * maxSide) / height);
        height = maxSide;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      // Re-encoding through canvas also strips EXIF (orientation is baked
      // in by drawImage, metadata is not carried into toDataURL output) —
      // this is how "no EXIF/personal metadata retained" is satisfied.
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", quality || 0.92);
      URL.revokeObjectURL(img.src);
      resolve({ base64: dataUrl.split(",")[1], width, height });
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function extractOutputText(json) {
  if (!json) return null;
  const steps = Array.isArray(json.steps) ? json.steps : Array.isArray(json.output) ? json.output : [];
  for (const step of steps) {
    const parts = Array.isArray(step && step.content) ? step.content : [];
    for (const part of parts) {
      if (part && part.type === "text" && part.text) return part.text;
    }
  }
  return json.output_text || null;
}

function friendlyError(err) {
  const m = String((err && err.message) || err);
  if (/API key not valid|API_KEY_INVALID/i.test(m)) return { code: "bad_key", message: "APIキーが正しくありません。設定から確認してください。" };
  if (/no longer available|not found|not supported/i.test(m)) return { code: "bad_model", message: "モデル名が古い可能性があります。設定の「モデル名」を、エラー詳細に出ているモデル名に書き換えてください。詳細: " + m };
  if (/RESOURCE_EXHAUSTED|quota|429/i.test(m)) return { code: "rate_limited", message: "利用上限に達しました。しばらく待ってから再試行してください。" };
  if (/PERMISSION_DENIED|403/i.test(m)) return { code: "forbidden", message: "このAPIキーでは利用できませんでした。Google AI Studioでキーの状態を確認してください。" };
  if (/Failed to fetch|NetworkError/i.test(m)) return { code: "network", message: "通信に失敗しました。電波状況を確認してもう一度お試しください。" };
  return { code: "unknown", message: "解析に失敗しました。もう一度お試しください。(" + m + ")" };
}

// One real call to the API, no retry — callWithValidation (below) is what
// adds the one-retry-on-invalid-shape behavior.
async function callOnce({ apiKey, model, promptText, images, schema }) {
  const parts = [{ type: "text", text: promptText }];
  for (const img of images || []) {
    parts.push({ type: "image", data: img.base64, mime_type: "image/jpeg" });
  }
  const body = {
    model,
    store: false,
    input: parts,
    response_format: { type: "text", mime_type: "application/json", schema }
  };
  const res = await fetch(INTERACTIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || "HTTPエラー " + res.status;
    throw new Error(msg);
  }
  const text = extractOutputText(json);
  if (!text) throw new Error("AIから結果が返りませんでした。");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw Object.assign(new Error("応答がJSONとして解釈できませんでした。"), { rawText: text });
  }
  return parsed;
}

// Calls once, validates the structural shape against `schema` (schemas.js
// validateAgainstSchema), and — only on a validation failure — retries
// exactly once with an explicit correction note appended to the prompt.
// A second failure surfaces as a real error rather than silently passing
// through malformed data.
async function callWithValidation({ apiKey, model, promptText, images, schema, validate, mock }) {
  if (mock) return mock;

  let parsed = await callOnce({ apiKey, model, promptText, images, schema });
  let errors = validate(parsed, schema);
  if (errors.length > 0) {
    const retryPrompt = promptText + "\n\n【重要】前回の出力は次の点でスキーマに違反していました。必ず修正してJSONのみを返してください: " + errors.join("; ");
    parsed = await callOnce({ apiKey, model, promptText: retryPrompt, images, schema });
    errors = validate(parsed, schema);
    if (errors.length > 0) {
      throw Object.assign(new Error("AIの応答が期待した形式になりませんでした: " + errors.join("; ")), { code: "invalid_shape" });
    }
  }
  return parsed;
}

if (typeof window !== "undefined") {
  window.GeminiClient = { resizeToBase64, callWithValidation, friendlyError, INTERACTIONS_URL };
}
if (typeof module !== "undefined") {
  module.exports = { extractOutputText, friendlyError };
}
