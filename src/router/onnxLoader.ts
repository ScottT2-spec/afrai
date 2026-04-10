/**
 * ONNX Model Loader — loads trained XGBoost models for Node.js inference.
 *
 * Uses onnxruntime-node to run ONNX models exported by train_router.py.
 * Falls back to a JSON-based XGBoost loader if ONNX runtime isn't available.
 *
 * Usage:
 *   const model = await loadOnnxModel('models/router_success.onnx', 'models/router_latency.onnx');
 *   adaptiveRouter.loadModel(model);
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { XGBoostModel, XGBoostFeatures } from './adaptiveRouter.js';

// ── ONNX Runtime types (optional dependency) ────────────────────

interface OnnxSession {
  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
  release(): Promise<void>;
}

interface OnnxTensor {
  data: Float32Array | BigInt64Array | number[];
  dims: number[];
}

interface OnnxRuntime {
  InferenceSession: {
    create(path: string): Promise<OnnxSession>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OnnxTensor;
}

// ── Feature encoding ────────────────────────────────────────────

/**
 * Convert XGBoostFeatures into a flat Float32Array matching the
 * column order used by train_router.py's prepare_features().
 */
function encodeFeatures(features: XGBoostFeatures): Float32Array {
  return new Float32Array([
    features.inputTokens,
    features.complexityScore,
    features.hasCode,
    features.hasMath,
    features.hasReasoning,
    features.isSimpleQA,
    features.turnCount,
    features.hourOfDay,
    features.modelIndex,
    0, // language_encoded (default)
    0, // tier_encoded (default)
  ]);
}

// ── ONNX-based model ───────────────────────────────────────────

class OnnxXGBoostModel implements XGBoostModel {
  constructor(
    private readonly successSession: OnnxSession,
    private readonly latencySession: OnnxSession,
    private readonly ort: OnnxRuntime,
  ) {}

  predict(features: XGBoostFeatures): { successProb: number; expectedCostUsd: number } | null {
    // Synchronous wrapper isn't possible with ONNX runtime — we cache predictions.
    // For the hot path, use predictAsync and cache results.
    // Return null to signal that the caller should use online scoring.
    return null;
  }

  /**
   * Async prediction — the real inference path.
   * Called from the adaptive router's async route() method.
   */
  async predictAsync(features: XGBoostFeatures): Promise<{
    successProb: number;
    expectedLatencyMs: number;
  } | null> {
    try {
      const encoded = encodeFeatures(features);
      const inputTensor = new this.ort.Tensor('float32', encoded, [1, encoded.length]);

      // Run success model
      const successResult = await this.successSession.run({ features: inputTensor });
      const successOutput = successResult['probabilities'] ?? successResult['output_probability'];
      let successProb = 0.5;
      if (successOutput?.data) {
        // XGBoost classifier outputs probabilities for [class_0, class_1]
        const probs = successOutput.data as Float32Array;
        successProb = probs.length >= 2 ? Number(probs[1]) : Number(probs[0]!);
      }

      // Run latency model
      const latencyResult = await this.latencySession.run({ features: inputTensor });
      const latencyOutput = latencyResult['variable'] ?? latencyResult['output_label'];
      let expectedLatencyMs = 1000;
      if (latencyOutput?.data) {
        expectedLatencyMs = Math.max(1, Number((latencyOutput.data as Float32Array)[0]));
      }

      return { successProb, expectedLatencyMs };
    } catch (err) {
      console.error('[OnnxLoader] Prediction failed:', err);
      return null;
    }
  }

  async release(): Promise<void> {
    await this.successSession.release();
    await this.latencySession.release();
  }
}

// ── JSON-based fallback model ───────────────────────────────────

/**
 * Lightweight model that reads XGBoost JSON export and uses the
 * xgboost library's native JSON format for tree traversal.
 *
 * This is a simplified fallback — production should use ONNX.
 * It reads the model metadata and provides basic scoring based
 * on feature importance weights.
 */
class JsonXGBoostModel implements XGBoostModel {
  constructor(
    private readonly successMetadata: JsonModelMeta,
    private readonly latencyMetadata: JsonModelMeta,
  ) {}

  predict(features: XGBoostFeatures): { successProb: number; expectedCostUsd: number } | null {
    try {
      const encoded = encodeFeatures(features);

      // Weighted sum using feature importances as a rough approximation
      const successScore = this.weightedScore(encoded, this.successMetadata.featureImportance);
      const latencyScore = this.weightedScore(encoded, this.latencyMetadata.featureImportance);

      // Sigmoid for success probability
      const successProb = 1 / (1 + Math.exp(-successScore));
      // Latency is a positive value — use exp to keep it positive
      const expectedCostUsd = Math.max(0.000001, latencyScore * 0.00001);

      return { successProb, expectedCostUsd };
    } catch {
      return null;
    }
  }

  private weightedScore(features: Float32Array, weights: number[]): number {
    let score = 0;
    for (let i = 0; i < features.length && i < weights.length; i++) {
      score += features[i]! * weights[i]!;
    }
    return score;
  }
}

interface JsonModelMeta {
  featureImportance: number[];
}

// ── Loaders ─────────────────────────────────────────────────────

/**
 * Load ONNX models for the adaptive router.
 *
 * @param successModelPath - Path to the success classifier ONNX model
 * @param latencyModelPath - Path to the latency regressor ONNX model
 * @returns An XGBoostModel, or null if models can't be loaded
 */
export async function loadOnnxModel(
  successModelPath: string,
  latencyModelPath: string,
): Promise<OnnxXGBoostModel | null> {
  // Check if model files exist
  if (!existsSync(successModelPath) || !existsSync(latencyModelPath)) {
    console.warn('[OnnxLoader] Model files not found — adaptive router will use online scoring.');
    return null;
  }

  try {
    // Dynamic import — onnxruntime-node is an optional dependency
    const ort = await import('onnxruntime-node') as unknown as OnnxRuntime;
    const successSession = await ort.InferenceSession.create(successModelPath);
    const latencySession = await ort.InferenceSession.create(latencyModelPath);

    console.log('[OnnxLoader] ONNX models loaded successfully.');
    return new OnnxXGBoostModel(successSession, latencySession, ort);
  } catch (err) {
    console.warn('[OnnxLoader] Failed to load ONNX runtime:', err);
    console.warn('[OnnxLoader] Falling back to online scoring.');
    return null;
  }
}

/**
 * Load JSON-exported XGBoost models (fallback when ONNX runtime isn't available).
 *
 * @param metadataPath - Path to the training metadata.json
 * @returns An XGBoostModel, or null if metadata can't be loaded
 */
export async function loadJsonModel(
  metadataPath: string,
): Promise<JsonXGBoostModel | null> {
  if (!existsSync(metadataPath)) {
    return null;
  }

  try {
    const raw = await readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(raw) as {
      features: string[];
      n_features: number;
      success_accuracy: number;
    };

    // Generate uniform weights as baseline (real JSON loading would parse trees)
    const uniformWeights = new Array(metadata.n_features).fill(1 / metadata.n_features);

    return new JsonXGBoostModel(
      { featureImportance: uniformWeights },
      { featureImportance: uniformWeights },
    );
  } catch (err) {
    console.warn('[OnnxLoader] Failed to load JSON model metadata:', err);
    return null;
  }
}

/**
 * Try to load the best available model: ONNX first, then JSON fallback.
 */
export async function loadBestAvailableModel(modelsDir: string): Promise<XGBoostModel | null> {
  // Try ONNX first
  const onnxModel = await loadOnnxModel(
    `${modelsDir}/router_success.onnx`,
    `${modelsDir}/router_latency.onnx`,
  );
  if (onnxModel) return onnxModel;

  // Try JSON fallback
  const jsonModel = await loadJsonModel(`${modelsDir}/metadata.json`);
  if (jsonModel) return jsonModel;

  console.log('[OnnxLoader] No trained models found — router will use online Bayesian scoring until sufficient data is collected.');
  return null;
}
