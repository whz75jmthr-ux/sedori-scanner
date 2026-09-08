// JSON Schemas for each Gemini Interactions API call, and a lightweight
// runtime validator. We keep three SEPARATE schemas/calls on purpose:
// detection (stage 1) must never contain a brand/model field at all, so the
// schema itself makes brand hallucination impossible at that stage.

const DETECTION_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          box_2d: {
            type: "array",
            items: { type: "number" },
            minItems: 4,
            maxItems: 4
          },
          category: { type: "string" },
          visible_features: { type: "string" },
          // Brand-agnostic "is this worth a closer look" signal — never a
          // brand/model guess, just visible value cues (see prompts.js).
          resale_interest: { type: "string", enum: ["high", "medium", "low"] },
          resale_reason: { type: "string" },
          discount_tag_visible: { type: "boolean" }
        },
        required: ["box_2d", "category", "visible_features", "resale_interest", "resale_reason", "discount_tag_visible"]
      }
    }
  },
  required: ["items"]
};

// Stage 3a: OCR + purely visual feature extraction. No brand/model allowed.
const OCR_SCHEMA = {
  type: "object",
  properties: {
    ocr_fragments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          image_index: { type: "number" },
          raw_text: { type: "string" },
          location: { type: "string" },
          text_confidence: { type: "string", enum: ["high", "medium", "low"] }
        },
        required: ["image_index", "raw_text", "location", "text_confidence"]
      }
    },
    visual_features: {
      type: "object",
      properties: {
        color: { type: "string" },
        material_guess: { type: "string" },
        hardware: { type: "string" },
        stitching_quality: { type: "string" },
        iconic_pattern_observed: { type: "string" },
        notable_marks: { type: "string" }
      },
      required: ["color", "material_guess", "hardware", "stitching_quality", "iconic_pattern_observed", "notable_marks"]
    },
    condition_notes: { type: "string" },
    insufficient_photos: { type: "boolean" },
    missing_angles: { type: "array", items: { type: "string" } }
  },
  required: ["ocr_fragments", "visual_features", "condition_notes", "insufficient_photos", "missing_angles"]
};

// Stage 3b: candidate matching. Operates ONLY on the structured output of
// OCR_SCHEMA (passed back in as text) — the model does not see the raw
// photos again for this call, so it cannot introduce new "observed" detail
// that wasn't already captured as text evidence.
const CANDIDATE_SCHEMA = {
  type: "object",
  properties: {
    brand_candidates: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          brand: { type: "string" },
          based_on: { type: "string", enum: ["exact_text_match", "iconic_pattern", "partial_text", "insufficient"] },
          supporting_evidence: { type: "array", items: { type: "string" } },
          contradicting_evidence: { type: "array", items: { type: "string" } }
        },
        required: ["brand", "based_on", "supporting_evidence", "contradicting_evidence"]
      }
    },
    model_candidates: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          model: { type: "string" },
          requires: { type: "string", enum: ["tag_or_serial_confirmed", "multiple_convergent_clues", "insufficient"] },
          supporting_evidence: { type: "array", items: { type: "string" } }
        },
        required: ["model", "requires", "supporting_evidence"]
      }
    },
    exact_ocr_brand_match: { type: "boolean" },
    model_number_confirmed_by_tag: { type: "boolean" },
    iconic_pattern_match: { type: "boolean" },
    category_only_reason: { type: "string" },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["brand_candidates", "model_candidates", "exact_ocr_brand_match", "model_number_confirmed_by_tag", "iconic_pattern_match", "category_only_reason", "warnings"]
};

// Minimal structural validator: checks required fields exist and have the
// right JS typeof. Not a full JSON-Schema implementation — Gemini's own
// responseSchema-guided generation does the heavy lifting; this is a
// second, independent check we control, so a malformed reply is caught
// instead of silently trusted.
function validateAgainstSchema(value, schema, path) {
  path = path || "$";
  const errors = [];
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [path + ": expected object"];
    }
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(path + "." + key + ": missing required field");
    }
    for (const key of Object.keys(schema.properties || {})) {
      if (key in value) {
        errors.push(...validateAgainstSchema(value[key], schema.properties[key], path + "." + key));
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return [path + ": expected array"];
    if (schema.minItems && value.length < schema.minItems) errors.push(path + ": too few items");
    if (schema.maxItems && value.length > schema.maxItems) errors.push(path + ": too many items (max " + schema.maxItems + ")");
    value.forEach((v, i) => {
      if (schema.items) errors.push(...validateAgainstSchema(v, schema.items, path + "[" + i + "]"));
    });
  } else if (schema.type === "string") {
    if (typeof value !== "string") errors.push(path + ": expected string");
    else if (schema.enum && !schema.enum.includes(value)) errors.push(path + ": value not in enum " + JSON.stringify(schema.enum));
  } else if (schema.type === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) errors.push(path + ": expected number");
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") errors.push(path + ": expected boolean");
  }
  return errors;
}

// Reads price numbers OUT OF a screenshot the user took of Mercari's own
// sold-item search results. This is OCR on real pixels the user is already
// looking at — not a market estimate — so it stays consistent with "never
// let the AI invent a number": it can only report digits actually printed
// in the image, never top up with general knowledge about typical prices.
const SOLD_PRICE_SCHEMA = {
  type: "object",
  properties: {
    prices: { type: "array", items: { type: "number" } },
    excluded_note: { type: "string" }
  },
  required: ["prices", "excluded_note"]
};

if (typeof module !== "undefined") {
  module.exports = { DETECTION_SCHEMA, OCR_SCHEMA, CANDIDATE_SCHEMA, SOLD_PRICE_SCHEMA, validateAgainstSchema };
}
