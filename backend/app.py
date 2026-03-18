import os
import pandas as pd
import numpy as np
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from werkzeug.utils import secure_filename

app = Flask(__name__)
CORS(app)

UPLOAD_FOLDER = 'uploads'
CLEANED_FOLDER = 'cleaned'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(CLEANED_FOLDER, exist_ok=True)

# ─── EDA LOGIC ───────────────────────────────────────────
def perform_eda(df):
    eda = {}
    eda['rows'], eda['columns'] = df.shape
    eda['dtypes'] = df.dtypes.apply(lambda x: str(x)).to_dict()
    eda['missing_values'] = df.isnull().sum().to_dict()
    eda['missing_pct'] = (df.isnull().sum() / len(df) * 100).round(2).to_dict()
    eda['duplicates'] = int(df.duplicated().sum())
    
    # Numeric stats
    numeric_df = df.select_dtypes(include='number')
    eda['numeric_columns'] = numeric_df.columns.tolist()
    eda['col_stats'] = {}
    for col in numeric_df.columns:
        stats = numeric_df[col].describe().to_dict()
        stats['skewness'] = round(float(numeric_df[col].skew()), 3)
        stats['kurtosis'] = round(float(numeric_df[col].kurt()), 3)
        eda['col_stats'][col] = {k: round(float(v), 2) if isinstance(v, (int, float)) else v for k, v in stats.items()}

    # Categorical stats
    cat_df = df.select_dtypes(include=['object', 'category'])
    eda['categorical_columns'] = cat_df.columns.tolist()
    eda['cat_stats'] = {}
    for col in cat_df.columns:
        counts = df[col].value_counts()
        eda['cat_stats'][col] = {
            'unique': int(df[col].nunique()),
            'top_value': str(counts.index[0]) if not counts.empty else "N/A",
            'top_freq': int(counts.values[0]) if not counts.empty else 0
        }

    # Data type distribution
    eda['data_type_counts'] = df.dtypes.value_counts().apply(lambda x: int(x)).to_dict()
    eda['data_type_counts'] = {str(k): v for k, v in eda['data_type_counts'].items()}

    # Correlation Summary
    if len(numeric_df.columns) > 1:
        corr = numeric_df.corr().unstack().sort_values(ascending=False)
        corr = corr[corr < 1].head(6) 
        eda['top_correlations'] = [{"cols": list(pair), "score": round(float(val), 3)} for pair, val in corr.to_dict().items()]
    else:
        eda['top_correlations'] = []

    # Text Insights
    insights = []
    if eda['duplicates'] > 0: insights.append(f"Found {eda['duplicates']} duplicate rows.")
    if sum(eda['missing_values'].values()) > 0: insights.append(f"Dataset has {sum(eda['missing_values'].values())} missing values.")
    for col, s in eda['col_stats'].items():
        if abs(s.get('skewness', 0)) > 1: insights.append(f"Column '{col}' is {'highly ' if abs(s['skewness']) > 2 else ''}{'right' if s['skewness'] > 0 else 'left'}-skewed.")
    
    eda['insights'] = insights
    return eda

# ─── PREPROCESSING LOGIC ─────────────────────────────────
def preprocess_df(df):
    steps = []
    original_rows = len(df)

    # Step 1: Drop fully empty columns
    empty_cols = [c for c in df.columns if df[c].isnull().all()]
    if empty_cols:
        df.drop(columns=empty_cols, inplace=True)
        steps.append(f"Dropped {len(empty_cols)} fully empty column(s): {', '.join(empty_cols)}.")
    else:
        steps.append("No fully empty columns found.")

    # Step 2: Drop duplicate rows
    dupe_count = int(df.duplicated().sum())
    if dupe_count > 0:
        df.drop_duplicates(inplace=True)
        steps.append(f"Removed {dupe_count} duplicate row(s).")
    else:
        steps.append("No duplicate rows found.")

    # Step 3: Fill missing values
    numeric_cols = df.select_dtypes(include="number").columns.tolist()
    categorical_cols = df.select_dtypes(include=["object", "category"]).columns.tolist()
    filled_numeric = []
    filled_cat = []

    for col in numeric_cols:
        missing = int(df[col].isnull().sum())
        if missing > 0:
            df[col].fillna(df[col].median(), inplace=True)
            filled_numeric.append(f"{col} ({missing} values → median)")

    for col in categorical_cols:
        missing = int(df[col].isnull().sum())
        if missing > 0:
            df[col].fillna(df[col].mode()[0], inplace=True)
            filled_cat.append(f"{col} ({missing} values → mode)")

    if filled_numeric:
        steps.append(f"Imputed numeric missing values with median: {', '.join(filled_numeric)}.")
    else:
        steps.append("No missing values in numeric columns.")

    if filled_cat:
        steps.append(f"Imputed categorical missing values with mode: {', '.join(filled_cat)}.")
    else:
        steps.append("No missing values in categorical columns.")

    # Step 4: Outlier removal (IQR)
    outlier_removed = []
    for col in numeric_cols:
        if col not in df.columns:
            continue
        Q1 = df[col].quantile(0.25)
        Q3 = df[col].quantile(0.75)
        IQR = Q3 - Q1
        lower = Q1 - 1.5 * IQR
        upper = Q3 + 1.5 * IQR
        before = len(df)
        df = df[(df[col] >= lower) & (df[col] <= upper)]
        removed = before - len(df)
        if removed > 0:
            outlier_removed.append(f"{col} ({removed} rows removed)")

    if outlier_removed:
        steps.append(f"Removed outliers via IQR method: {', '.join(outlier_removed)}.")
    else:
        steps.append("No outliers detected via IQR method.")

    final_rows = len(df)
    steps.append(f"Final dataset: {final_rows} rows (started with {original_rows}, removed {original_rows - final_rows} total rows).")

    return df.reset_index(drop=True), steps

# ─── DRIFT DETECTION ─────────────────────────────────────
def detect_drift(baseline_df, current_df):
    common_cols = list(set(baseline_df.columns) & set(current_df.columns))
    drift_report = {}
    
    for col in common_cols:
        if pd.api.types.is_numeric_dtype(baseline_df[col]):
            b_mean = baseline_df[col].mean()
            c_mean = current_df[col].mean()
            b_std = baseline_df[col].std() or 1.0
            diff = abs(b_mean - c_mean)
            score = diff / b_std
            drift_report[col] = {
                "baseline_mean": round(float(b_mean), 2),
                "current_mean": round(float(c_mean), 2),
                "drift_score": round(float(diff), 4),
                "normalised_score": round(float(min(score, 1.0)), 2),
                "status": "Drift" if score > 0.5 else "Stable"
            }
    return drift_report

# ─── ROUTES ──────────────────────────────────────────────
@app.route('/upload/baseline', methods=['POST'])
def upload_baseline():
    if 'file' not in request.files: return jsonify({"error": "No file"}), 400
    file = request.files['file']
    filename = secure_filename(file.filename)
    path = os.path.join(UPLOAD_FOLDER, 'baseline.csv')
    file.save(path)
    
    df = pd.read_csv(path)
    eda = perform_eda(df)
    cleaned_df, log = preprocess_df(df)
    cleaned_df.to_csv(os.path.join(CLEANED_FOLDER, 'baseline_cleaned.csv'), index=False)
    
    return jsonify({
        "message": "Baseline uploaded successfully",
        "eda": eda,
        "preprocessing_log": log,
        "filename": filename
    })

@app.route('/upload/current', methods=['POST'])
def upload_current():
    if 'file' not in request.files: return jsonify({"error": "No file"}), 400
    file = request.files['file']
    filename = secure_filename(file.filename)
    path = os.path.join(UPLOAD_FOLDER, 'current.csv')
    file.save(path)
    
    df = pd.read_csv(path)
    eda = perform_eda(df)
    cleaned_df, log = preprocess_df(df)
    cleaned_df.to_csv(os.path.join(CLEANED_FOLDER, 'current_cleaned.csv'), index=False)
    
    drift = {}
    baseline_path = os.path.join(CLEANED_FOLDER, 'baseline_cleaned.csv')
    if os.path.exists(baseline_path):
        baseline_df = pd.read_csv(baseline_path)
        drift = detect_drift(baseline_df, cleaned_df)
        
    return jsonify({
        "message": "Current uploaded successfully",
        "eda": eda,
        "preprocessing_log": log,
        "drift": drift,
        "filename": filename
    })

@app.route('/download/<type>')
def download(type):
    filename = 'baseline_cleaned.csv' if type == 'baseline' else 'current_cleaned.csv'
    if os.path.exists(os.path.join(CLEANED_FOLDER, filename)):
        return send_from_directory(CLEANED_FOLDER, filename, as_attachment=True)
    return jsonify({"error": "File not found"}), 404

if __name__ == '__main__':
    app.run(debug=True)
