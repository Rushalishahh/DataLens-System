const BASE_URL = "http://localhost:5000";

let baselineResult = null;
let currentResult  = null;
let activeChart     = "baseline";
let chartInstance   = null;
let typeChartInstance = null;

// ─── DOM ELEMENTS ─────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    checkConnection();
    setupUpload("baseline");
    setupUpload("current");
});

async function checkConnection() {
    try {
        const res = await fetch(`${BASE_URL}/upload/baseline`, { method: "OPTIONS" });
        updateStatus(true);
    } catch {
        updateStatus(false);
    }
}

function updateStatus(isOnline) {
    const dot = document.querySelector(".dot");
    const text = document.querySelector(".status-text");
    if (isOnline) {
        dot.className = "dot online";
        text.innerText = "System Online";
    } else {
        dot.className = "dot offline";
        text.innerText = "System Offline";
    }
}

// ─── UPLOAD HANDLERS ──────────────────────────────────────
function setupUpload(type) {
    const zone  = document.getElementById(`${type}Zone`);
    const input = document.getElementById(`${type}File`);
    const btn   = document.getElementById(`upload${type.charAt(0).toUpperCase() + type.slice(1)}`);

    zone.addEventListener("click", () => input.click());
    
    input.addEventListener("change", (e) => {
        if (e.target.files[0]) {
            zone.querySelector(".upload-hint").innerText = `Selected: ${e.target.files[0].name}`;
            zone.classList.add("has-file");
        }
    });

    btn.addEventListener("click", async () => {
        const file = input.files[0];
        if (!file) return showToast(`Please select a ${type} file first`, "error");

        const formData = new FormData();
        formData.append("file", file);

        setLoading(btn, true, "Analyzing...");
        try {
            const res = await fetch(`${BASE_URL}/upload/${type}`, {
                method: "POST",
                body: formData
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            if (type === "baseline") baselineResult = data;
            else                     currentResult  = data;

            showToast(`${type.charAt(0).toUpperCase() + type.slice(1)} analyzed successfully!`, "success");
            renderDashboard();
        } catch (err) {
            showToast(err.message, "error");
        } finally {
            setLoading(btn, false, `Upload & Analyze ${type.charAt(0).toUpperCase() + type.slice(1)}`);
        }
    });
}

// ─── DASHBOARD RENDERER ───────────────────────────────────
function renderDashboard() {
    const resultsRoot = document.getElementById("resultsRoot");
    const reportGrid  = document.getElementById("reportGrid");
    const chartsSection = document.getElementById("chartsSection");

    if (!baselineResult && !currentResult) {
        resultsRoot.style.display = "none";
        return;
    }

    resultsRoot.style.display = "block";
    chartsSection.style.display = "block";

    const hasBoth = baselineResult && currentResult;

    // Build the report panel(s)
    if (hasBoth) {
        reportGrid.className = "report-grid two-col";
        reportGrid.innerHTML = 
            renderReportPanel(baselineResult, "baseline") +
            renderReportPanel(currentResult,  "current");
    } else {
        reportGrid.className = "report-grid one-col";
        const result = baselineResult || currentResult;
        reportGrid.innerHTML = renderReportPanel(result, baselineResult ? "baseline" : "current");
    }

    // Update charts based on active selection
    if (!hasBoth) activeChart = baselineResult ? "baseline" : "current";
    updateToggleButtons();
    drawCharts(activeChart === "baseline" ? baselineResult : currentResult);

    // Drift Section
    const driftSection  = document.getElementById("driftSection");
    const driftContent  = document.getElementById("driftContent");
    if (hasBoth && currentResult.drift && Object.keys(currentResult.drift).length > 0) {
        driftSection.style.display = "block";
        driftContent.innerHTML = renderDriftTable(currentResult.drift);
    } else {
        driftSection.style.display = "none";
    }

    resultsRoot.scrollIntoView({ behavior: "smooth" });
}

// ─── REPORT PANEL HTML ───────────────────────────────────
function renderReportPanel(result, type) {
    const eda   = result.eda;
    const log   = result.preprocessing_log;
    const label = result.label || (type === "baseline" ? "Baseline" : "Current");
    const tagColor = type === "baseline" ? "var(--primary)" : "#059669";

    // Stat pills
    const statPills = `
        <div class="stat-pills">
            <div class="pill"><span class="pill-val">${eda.rows}</span><span class="pill-lbl">Rows</span></div>
            <div class="pill"><span class="pill-val">${eda.columns}</span><span class="pill-lbl">Columns</span></div>
            <div class="pill"><span class="pill-val">${eda.numeric_columns.length}</span><span class="pill-lbl">Numeric</span></div>
            <div class="pill"><span class="pill-val">${eda.categorical_columns.length}</span><span class="pill-lbl">Categorical</span></div>
            <div class="pill"><span class="pill-val">${eda.duplicates}</span><span class="pill-lbl">Duplicates</span></div>
        </div>`;

    // EDA Insights
    const insightsHtml = eda.insights.map(i => `<li class="insight-item">💡 ${i}</li>`).join("");

    // Column stats table
    let numericTable = "";
    if (eda.numeric_columns.length > 0) {
        const rows = eda.numeric_columns.map(col => {
            const s = eda.col_stats[col];
            const skewBadge = Math.abs(s.skewness) > 1 
                ? `<span class="skew-badge">${s.skewness > 0 ? "▲ right" : "▼ left"}</span>` : "";
            return `<tr>
                <td><b>${col}</b></td>
                <td>${s.mean}</td>
                <td>${s.median}</td>
                <td>${s.std}</td>
                <td>${skewBadge || s.skewness}</td>
            </tr>`;
        }).join("");
        numericTable = `
            <div class="table-section">
                <h4 class="sub-heading">📐 Numeric Stats</h4>
                <div class="data-table-container">
                    <table>
                        <thead><tr><th>Column</th><th>Mean</th><th>Med</th><th>Std</th><th>Skew</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>`;
    }

    // Missing values
    const missingCols = Object.entries(eda.missing_values).filter(([,v]) => v > 0);
    const missingHtml = missingCols.length === 0
        ? `<p class="no-missing">✅ No missing values found.</p>`
        : `<div class="missing-grid">${missingCols.map(([col, val]) => `
            <div class="missing-item">
                <span class="missing-col">${col}</span>
                <div class="missing-bar-wrap">
                    <div class="missing-bar" style="width:${eda.missing_pct[col]}%"></div>
                </div>
                <span class="missing-count">${val} (${eda.missing_pct[col]}%)</span>
            </div>`).join("")}</div>`;

    // Preprocessing steps — colour-coded by what actually changed
    const prepSteps = log.map((step, i) => {
        let icon = "✅";
        let cls  = "prep-ok";
        if (/removed|dropped|outlier/i.test(step) && !/(no |not found|0 )/i.test(step)) {
            icon = "✂️"; cls = "prep-removed";
        } else if (/imputed|fillna|missing.*values/i.test(step) && !/no missing/i.test(step)) {
            icon = "🔄"; cls = "prep-changed";
        } else if (/duplicate/i.test(step) && !/no duplicate/i.test(step)) {
            icon = "🗑️"; cls = "prep-removed";
        } else if (/(no |not found|no missing|no outlier|no fully)/i.test(step)) {
            icon = "✅"; cls = "prep-ok";
        } else if (/final dataset/i.test(step)) {
            icon = "📦"; cls = "prep-summary";
        }
        return `
        <div class="prep-step ${cls}">
            <div class="prep-icon">${icon}</div>
            <div class="prep-content">
                <div class="prep-num">Step ${i+1}</div>
                <div class="prep-text">${step}</div>
            </div>
        </div>`;
    }).join("");

    return `
    <div class="report-panel card">
        <div class="report-header">
            <h2 style="color:${tagColor}">${type === "baseline" ? "📁" : "📈"} ${label} Report</h2>
        </div>

        ${statPills}

        <div class="section-block">
            <h4 class="sub-heading">🔍 EDA Insights</h4>
            <ul class="insights-list">${insightsHtml}</ul>
        </div>

        <div class="section-block">
            <h4 class="sub-heading">⚠️ Missing Values</h4>
            ${missingHtml}
        </div>

        ${numericTable}

        <div class="section-block">
            <h4 class="sub-heading">🔧 Preprocessing Steps</h4>
            <div class="prep-timeline">${prepSteps}</div>
        </div>

        <div class="download-section">
            <button class="btn-download-big" onclick="downloadCleaned('${type}')">⬇️ Download Cleaned CSV</button>
        </div>
    </div>`;
}

// ─── DRIFT TABLE ──────────────────────────────────────────
function renderDriftTable(drift) {
    const rows = Object.entries(drift).map(([col, d]) => {
        const cls = d.status.toLowerCase();
        const bar = `<div class="drift-bar-wrap"><div class="drift-bar ${cls}" style="width:${Math.min(d.normalised_score * 100, 100)}%"></div></div>`;
        return `<tr>
            <td><b>${col}</b></td>
            <td>${d.baseline_mean}</td>
            <td>${d.current_mean}</td>
            <td>${bar}</td>
            <td><span class="status-tag ${cls}">${d.status === "Drift" ? "⚠️ Drift" : "✅ Stable"}</span></td>
        </tr>`;
    }).join("");

    return `<div class="data-table-container">
        <table>
            <thead><tr><th>Column</th><th>Base Mean</th><th>Curr Mean</th><th>Severity</th><th>Status</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
}

// ─── CHART TOGGLE ─────────────────────────────────────────
function switchChart(which) {
    activeChart = which;
    updateToggleButtons();
    const result = which === "baseline" ? baselineResult : currentResult;
    if (result) drawCharts(result);
}

function updateToggleButtons() {
    const b = document.getElementById("toggleBaseline");
    const c = document.getElementById("toggleCurrent");
    if (b) b.classList.toggle("active", activeChart === "baseline");
    if (c) c.classList.toggle("active",  activeChart === "current");
}

// ─── CHARTS ───────────────────────────────────────────────
function drawCharts(result) {
    if (!result) return;
    createMissingChart(result.eda.missing_values);
    createTypeChart(result.eda.data_type_counts);
}

function createMissingChart(missingValues) {
    const canvas = document.getElementById("chartCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (chartInstance) chartInstance.destroy();

    const labels = Object.keys(missingValues);
    const data   = Object.values(missingValues);

    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, "rgba(124, 58, 237, 0.9)");
    gradient.addColorStop(1, "rgba(167, 139, 250, 0.3)");

    chartInstance = new Chart(ctx, {
        type: "bar",
        data: {
            labels,
            datasets: [{
                label: "Missing Values",
                data,
                backgroundColor: gradient,
                borderColor: "#7c3aed",
                borderWidth: 2,
                borderRadius: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: "rgba(124, 58, 237, 0.08)" } },
                x: { grid: { display: false } }
            }
        }
    });
}

function createTypeChart(typeData) {
    const canvas = document.getElementById("typeChartCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (typeChartInstance) typeChartInstance.destroy();

    typeChartInstance = new Chart(ctx, {
        type: "doughnut",
        data: {
            labels: Object.keys(typeData),
            datasets: [{
                data: Object.values(typeData),
                backgroundColor: ["#7c3aed", "#059669", "#d97706", "#dc2626", "#3b82f6"],
                borderColor: "#ffffff",
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "70%",
            plugins: { legend: { position: "bottom" } }
        }
    });
}

// ─── DOWNLOAD ─────────────────────────────────────────────
async function downloadCleaned(type) {
    window.open(`${BASE_URL}/download/${type}`, "_blank");
}

// ─── UI HELPERS ───────────────────────────────────────────
function setLoading(btn, isLoading, label) {
    btn.disabled = isLoading;
    if (btn.querySelector("span")) btn.querySelector("span").innerText = label;
    if (isLoading) btn.classList.add("loading");
    else           btn.classList.remove("loading");
}

function showToast(message, type = "info") {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.innerText = message;
    toast.className = `show ${type}`;
    setTimeout(() => toast.className = "", 3500);
}
