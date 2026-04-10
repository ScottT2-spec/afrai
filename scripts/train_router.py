#!/usr/bin/env python3
"""
AfrAI Adaptive Router — XGBoost Training Script

Trains a gradient boosted decision tree on historical request outcomes.
Produces an ONNX model that the Node.js router loads for predictions.

Run schedule: every 6 hours (via cron or CI/CD)

Usage:
  python scripts/train_router.py --input data/outcomes.csv --output models/router_model.onnx
  python scripts/train_router.py --db postgresql://... --output models/router_model.onnx

Requirements:
  pip install xgboost scikit-learn pandas numpy onnx skl2onnx psycopg2-binary
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, mean_absolute_error
from sklearn.preprocessing import LabelEncoder


# ── Feature columns ──────────────────────────────────────────────

NUMERIC_FEATURES = [
    'input_tokens',
    'complexity_score',
    'has_code',
    'has_math',
    'has_reasoning',
    'is_simple_qa',
    'turn_count',
    'hour_of_day',
    'model_index',
]

CATEGORICAL_FEATURES = [
    'language',
    'tenant_tier',
]

TARGET_SUCCESS = 'success'
TARGET_LATENCY = 'latency_ms'
TARGET_COST = 'cost_usd'


# ── Data loading ─────────────────────────────────────────────────

def load_from_csv(path: str) -> pd.DataFrame:
    """Load training data from CSV (exported by OutcomeCollector.toCSV)."""
    df = pd.read_csv(path)
    print(f"Loaded {len(df)} records from {path}")
    return df


def load_from_db(db_url: str, window_days: int = 7) -> pd.DataFrame:
    """Load training data from PostgreSQL usage_logs table."""
    import psycopg2

    cutoff = datetime.utcnow() - timedelta(days=window_days)
    query = """
        SELECT
            input_tokens, output_tokens,
            CAST(complexity_score AS FLOAT) as complexity_score,
            model, provider,
            CAST(cost_usd AS FLOAT) as cost_usd,
            latency_ms,
            status,
            created_at
        FROM usage_logs
        WHERE created_at >= %s
        ORDER BY created_at ASC
    """

    conn = psycopg2.connect(db_url)
    df = pd.read_sql(query, conn, params=[cutoff])
    conn.close()

    # Map status to success boolean
    df['success'] = (df['status'] == 'success').astype(int)
    print(f"Loaded {len(df)} records from database (last {window_days} days)")
    return df


def encode_model_id(model_id: str) -> int:
    """Encode model ID to numeric index (must match adaptiveRouter.ts)."""
    model_map = {
        'gpt-4o': 0, 'gpt-4o-mini': 1,
        'claude-3-5-sonnet-20241022': 2, 'claude-3-5-haiku-20241022': 3,
        'gemini-1.5-pro': 4, 'gemini-1.5-flash': 5,
        'command-r-plus': 6, 'command-r': 7,
        'llama-3.3-70b-versatile': 8, 'llama-3.1-8b-instant': 9,
        'mixtral-8x7b-32768': 10, 'gemma2-9b-it': 11,
        'Meta-Llama-3.1-405B-Instruct': 12, 'Meta-Llama-3.1-70B-Instruct': 13,
    }
    return model_map.get(model_id, -1)


# ── Feature engineering ──────────────────────────────────────────

def prepare_features(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, pd.Series]:
    """
    Prepare features and targets for training.

    Returns:
        X: feature DataFrame
        y_success: binary target (1 = success, 0 = failure)
        y_latency: continuous target (latency in ms)
    """
    # Encode model ID if present as string
    if 'model_id' in df.columns:
        df['model_index'] = df['model_id'].apply(encode_model_id)
    elif 'model' in df.columns:
        df['model_index'] = df['model'].apply(encode_model_id)

    # Encode categorical features
    if 'language' in df.columns:
        le_lang = LabelEncoder()
        df['language_encoded'] = le_lang.fit_transform(df['language'].fillna('en'))
    else:
        df['language_encoded'] = 0

    if 'tenant_tier' in df.columns:
        tier_map = {'free': 0, 'starter': 1, 'growth': 2, 'enterprise': 3}
        df['tier_encoded'] = df['tenant_tier'].map(tier_map).fillna(0)
    else:
        df['tier_encoded'] = 0

    # Extract hour of day from timestamp
    if 'hour_of_day' not in df.columns:
        if 'created_at' in df.columns:
            df['hour_of_day'] = pd.to_datetime(df['created_at']).dt.hour
        elif 'timestamp' in df.columns:
            df['hour_of_day'] = pd.to_datetime(df['timestamp'], unit='ms').dt.hour
        else:
            df['hour_of_day'] = 12  # default

    # Fill missing boolean features
    for col in ['has_code', 'has_math', 'has_reasoning', 'is_simple_qa']:
        if col not in df.columns:
            df[col] = 0

    if 'turn_count' not in df.columns:
        df['turn_count'] = 1

    if 'complexity_score' not in df.columns:
        df['complexity_score'] = 0.5

    # Select feature columns
    feature_cols = [
        'input_tokens', 'complexity_score', 'has_code', 'has_math',
        'has_reasoning', 'is_simple_qa', 'turn_count', 'hour_of_day',
        'model_index', 'language_encoded', 'tier_encoded',
    ]

    X = df[feature_cols].fillna(0).astype(float)
    y_success = df['success'].astype(int) if 'success' in df.columns else pd.Series([1] * len(df))
    y_latency = df['latency_ms'].astype(float) if 'latency_ms' in df.columns else pd.Series([1000] * len(df))

    return X, y_success, y_latency


# ── Training ─────────────────────────────────────────────────────

def train_success_model(X: pd.DataFrame, y: pd.Series) -> xgb.XGBClassifier:
    """Train a binary classifier: P(success | features)."""
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    model = xgb.XGBClassifier(
        n_estimators=100,
        max_depth=6,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        eval_metric='logloss',
        random_state=42,
        use_label_encoder=False,
    )

    model.fit(
        X_train, y_train,
        eval_set=[(X_test, y_test)],
        verbose=False,
    )

    # Evaluate
    y_pred = model.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    print(f"Success model accuracy: {acc:.4f}")

    return model


def train_latency_model(X: pd.DataFrame, y: pd.Series) -> xgb.XGBRegressor:
    """Train a regressor: E[latency | features]."""
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    model = xgb.XGBRegressor(
        n_estimators=100,
        max_depth=6,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        eval_metric='mae',
        random_state=42,
    )

    model.fit(
        X_train, y_train,
        eval_set=[(X_test, y_test)],
        verbose=False,
    )

    # Evaluate
    y_pred = model.predict(X_test)
    mae = mean_absolute_error(y_test, y_pred)
    print(f"Latency model MAE: {mae:.1f}ms")

    return model


# ── Export ────────────────────────────────────────────────────────

def export_to_onnx(
    success_model: xgb.XGBClassifier,
    latency_model: xgb.XGBRegressor,
    output_dir: str,
    n_features: int,
) -> None:
    """Export XGBoost models to ONNX format for Node.js inference."""
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType

    os.makedirs(output_dir, exist_ok=True)

    initial_type = [('features', FloatTensorType([None, n_features]))]

    # Success model → ONNX
    success_onnx = convert_sklearn(success_model, initial_types=initial_type)
    success_path = os.path.join(output_dir, 'router_success.onnx')
    with open(success_path, 'wb') as f:
        f.write(success_onnx.SerializeToString())
    print(f"Success model exported to {success_path}")

    # Latency model → ONNX
    latency_onnx = convert_sklearn(latency_model, initial_types=initial_type)
    latency_path = os.path.join(output_dir, 'router_latency.onnx')
    with open(latency_path, 'wb') as f:
        f.write(latency_onnx.SerializeToString())
    print(f"Latency model exported to {latency_path}")


def export_to_json(
    success_model: xgb.XGBClassifier,
    latency_model: xgb.XGBRegressor,
    output_dir: str,
) -> None:
    """Export models as JSON (fallback for environments without ONNX runtime)."""
    os.makedirs(output_dir, exist_ok=True)

    success_path = os.path.join(output_dir, 'router_success.json')
    success_model.save_model(success_path)
    print(f"Success model exported to {success_path}")

    latency_path = os.path.join(output_dir, 'router_latency.json')
    latency_model.save_model(latency_path)
    print(f"Latency model exported to {latency_path}")


# ── Main ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Train AfrAI adaptive router model')
    parser.add_argument('--input', type=str, help='Path to CSV training data')
    parser.add_argument('--db', type=str, help='PostgreSQL connection URL')
    parser.add_argument('--window-days', type=int, default=7, help='Rolling window for DB data (days)')
    parser.add_argument('--output', type=str, default='models/', help='Output directory for models')
    parser.add_argument('--format', choices=['onnx', 'json', 'both'], default='both', help='Export format')
    parser.add_argument('--min-rows', type=int, default=1000, help='Minimum rows required to train')

    args = parser.parse_args()

    # Load data
    if args.input:
        df = load_from_csv(args.input)
    elif args.db:
        df = load_from_db(args.db, args.window_days)
    elif os.environ.get('DATABASE_URL'):
        df = load_from_db(os.environ['DATABASE_URL'], args.window_days)
    else:
        print("Error: provide --input (CSV) or --db (PostgreSQL URL) or set DATABASE_URL")
        sys.exit(1)

    if len(df) < args.min_rows:
        print(f"Only {len(df)} records — need at least {args.min_rows}. Skipping training.")
        sys.exit(0)

    # Prepare features
    X, y_success, y_latency = prepare_features(df)
    print(f"Features shape: {X.shape}")

    # Train models
    print("\n── Training success model ──")
    success_model = train_success_model(X, y_success)

    print("\n── Training latency model ──")
    latency_model = train_latency_model(X, y_latency)

    # Feature importance
    print("\n── Feature importance (success model) ──")
    importance = success_model.feature_importances_
    for name, imp in sorted(zip(X.columns, importance), key=lambda x: -x[1]):
        print(f"  {name}: {imp:.4f}")

    # Export
    print(f"\n── Exporting to {args.output} ──")
    if args.format in ('json', 'both'):
        export_to_json(success_model, latency_model, args.output)
    if args.format in ('onnx', 'both'):
        try:
            export_to_onnx(success_model, latency_model, args.output, X.shape[1])
        except ImportError:
            print("Warning: skl2onnx not installed, skipping ONNX export")
            print("Install with: pip install skl2onnx onnx")

    # Save metadata
    metadata = {
        'trained_at': datetime.utcnow().isoformat(),
        'records_used': len(df),
        'features': list(X.columns),
        'n_features': X.shape[1],
        'success_accuracy': float(accuracy_score(
            y_success[:len(y_success)//5],
            success_model.predict(X[:len(X)//5])
        )),
    }
    meta_path = os.path.join(args.output, 'metadata.json')
    with open(meta_path, 'w') as f:
        json.dump(metadata, f, indent=2)
    print(f"Metadata saved to {meta_path}")

    print("\n✅ Training complete!")


if __name__ == '__main__':
    main()
