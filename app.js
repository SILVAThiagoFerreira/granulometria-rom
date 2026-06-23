/* =====================================================================
   Granulometria do Material Desmontado (ROM) — US Vale Verde
   Lê em tempo real a planilha Google Sheets (gviz) e renderiza os gráficos.
   Atualiza a cada acesso — sem servidor, sem build.
   ===================================================================== */

const SHEET_ID = "1YZ8g4pAOcfiktvysQvdlRwVcLvVnZrz_";
const GVIZ_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&headers=1`;
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
const META_D80 = 400; // mm — meta de D80 da operação

// ---------- Paleta (clean · consultoria) ----------
const C = {
  green: "#1f4d3a",
  greenFill: "rgba(31,77,58,0.10)",
  neutral: "#cdd1cc",   // não-conforme
  meta: "#9aa099",      // linha de meta
  grid: "rgba(0,0,0,0.06)",
  text: "#6b7174",
  ink: "#1a1a1a",
};

// Percentis da curva granulométrica na ordem esperada
const PERCENTILES = [1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 99, 100];

// ---------- Utilitários ----------
const norm = (s) =>
  (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/\s+/g, " ").trim();

const fmtInt = (n) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(n || 0);
const fmtNum = (n, d = 0) =>
  new Intl.NumberFormat("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);

const parseDateCell = (v) => {
  if (!v) return null;
  const m = String(v).match(/Date\((\d+),(\d+),(\d+)/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2] + 1, d: +m[3] };
};

// ---------- Estado ----------
let RECORDS = [];
let CHARTS = {};

// ---------- Carregamento da planilha ----------
async function loadSheet() {
  setStatus("loading", "Carregando dados da planilha…");
  let table;
  try {
    const res = await fetch(GVIZ_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("gviz HTTP " + res.status);
    const txt = await res.text();
    table = parseGviz(txt);
  } catch (e) {
    console.warn("gviz falhou, tentando CSV:", e);
    try {
      const res = await fetch(CSV_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("csv HTTP " + res.status);
      table = parseCsv(await res.text());
    } catch (e2) {
      setStatus("error", "Não foi possível acessar a planilha. Verifique se o link está público.");
      throw e2;
    }
  }
  RECORDS = buildRecords(table);
  if (!RECORDS.length) {
    setStatus("error", "Planilha acessada, mas nenhum registro encontrado.");
    return;
  }
  populateFilters();
  setStatus("ok", `${RECORDS.length} desmontes carregados da planilha.`);
  document.getElementById("last-update").textContent = "Atualizado em " + nowBR();
  render();
}

function parseGviz(txt) {
  const m = txt.match(/setResponse\((\{.*\})\);?\s*$/s);
  const json = JSON.parse(m ? m[1] : txt);
  return json.table;
}

function parseCsv(text) {
  const rows = csvToRows(text);
  const headers = rows.shift().map(norm);
  const cols = headers.map((label) => ({ id: label, label, type: "string" }));
  const tableRows = rows.map((r) => ({
    c: headers.map((h) => ({ v: r[headers.indexOf(h)] ?? null })),
  }));
  return { cols, rows: tableRows };
}

// parser CSV simples (lida com aspas e vírgulas entre aspas)
function csvToRows(text) {
  const out = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n") { row.push(cur); out.push(row); row = []; cur = ""; }
      else if (ch === "\r") { /* skip */ }
      else cur += ch;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); out.push(row); }
  return out;
}

// Mapeia colunas por rótulo (robusto a reordenação / acentos)
function buildRecords(table) {
  const idx = {};
  table.cols.forEach((c, i) => { idx[norm(c.label)] = i; });

  const get = (key) => {
    const i = idx[key];
    return i === undefined ? -1 : i;
  };

  const f = {
    poligonal: get("POLIGONAL"),
    banco: get("BANCO"),
    data: get("DATA DO DESMONTE"),
    dia: get("DIA"),
    mes: get("MES"),
    ano: get("ANO"),
    massa: get("MASSA (T)"),
    d80: get("D80 (MM)"),
    meta: get("META D80 (MM)"),
    sph: get("SPH INDEX"),
    volume: get("VOLUME (M3)"),
  };

  // curva: todas as colunas Dxx
  const curveCols = [];
  table.cols.forEach((c, i) => {
    const lb = norm(c.label);
    const m = lb.match(/^D(\d{1,3})(?:\s*\(MM\))?$/);
    if (m) curveCols.push({ pct: +m[1], i });
  });

  const recs = [];
  for (const r of table.rows) {
    const cell = (i) => (i < 0 ? null : (r.c[i] && r.c[i].v != null ? r.c[i].v : null));
    const d80 = num(cell(f.d80));
    if (d80 == null) continue; // sem D80 não é útil para granulometria

    const dt = parseDateCell(cell(f.data));
    const ano = num(cell(f.ano)) || (dt ? dt.y : null);
    const mes = num(cell(f.mes)) || (dt ? dt.mo : null);

    const curve = {};
    for (const cc of curveCols) {
      const v = num(cell(cc.i));
      if (v != null) curve[cc.pct] = v;
    }

    recs.push({
      poligonal: cell(f.poligonal),
      banco: num(cell(f.banco)),
      ano, mes, date: dt,
      massa: num(cell(f.massa)) || 0,
      volume: num(cell(f.volume)) || 0,
      d80,
      meta: num(cell(f.meta)) || META_D80,
      sph: num(cell(f.sph)),
      curve,
    });
  }
  return recs;

  function num(v) {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
    return isFinite(n) ? n : null;
  }
}

// ---------- Filtros ----------
function populateFilters() {
  const years = [...new Set(RECORDS.map((r) => r.ano).filter(Boolean))].sort();
  const benches = [...new Set(RECORDS.map((r) => r.banco).filter((v) => v != null))].sort((a, b) => a - b);

  const ySel = document.getElementById("filter-year");
  const bSel = document.getElementById("filter-bench");
  ySel.innerHTML = `<option value="">Todos os anos</option>` +
    years.map((y) => `<option value="${y}">${y}</option>`).join("");
  bSel.innerHTML = `<option value="">Todos os bancos</option>` +
    benches.map((b) => `<option value="${b}">Banco ${fmtInt(b)}</option>`).join("");

  ySel.onchange = render;
  bSel.onchange = render;
  document.getElementById("filter-reset").onclick = () => {
    ySel.value = ""; bSel.value = ""; render();
  };
}

function filtered() {
  const y = document.getElementById("filter-year").value;
  const b = document.getElementById("filter-bench").value;
  return RECORDS.filter((r) =>
    (!y || String(r.ano) === y) && (!b || String(r.banco) === b)
  );
}

// ---------- Render ----------
function render() {
  const data = filtered();
  renderKpis(data);
  renderCurve(data);
  renderHist(data);
  renderD80(data);
  renderBench(data);
  renderTrend(data);
}

function renderKpis(data) {
  const d80s = data.map((r) => r.d80).filter((v) => v != null);
  const mean = d80s.length ? d80s.reduce((a, b) => a + b, 0) / d80s.length : 0;
  const conf = d80s.filter((v) => v <= META_D80).length;
  const mass = data.reduce((a, r) => a + (r.massa || 0), 0);

  document.getElementById("kpi-count").textContent = fmtInt(data.length);
  document.getElementById("kpi-count-hint").textContent =
    data.length ? `${fmtInt(data.length)} desmontes no filtro` : " ";
  document.getElementById("kpi-d80").textContent = fmtNum(mean, 0) + " mm";
  const confPct = d80s.length ? (conf / d80s.length) * 100 : 0;
  const confEl = document.getElementById("kpi-conf");
  confEl.textContent = fmtNum(confPct, 0) + "%";
  confEl.style.color = confPct >= 70 ? C.green : "#9c4a3f";
  document.getElementById("kpi-conf-hint").textContent = `${fmtInt(conf)} de ${fmtInt(d80s.length)} dentro da meta`;
  document.getElementById("kpi-mass").textContent = fmtNum(mass / 1000, 0) + " kt";
  document.getElementById("kpi-mass-hint").textContent = fmtInt(mass) + " t desmontadas";
}

// --- Curva granulométrica média ---
function renderCurve(data) {
  // Só inclui percentis bem preenchidos no filtro atual — evita curva
  // não-monotônica causada por colunas pouco preenchidas na planilha.
  let minCount = Math.max(3, Math.round(0.3 * data.length));
  let points = pickCurvePoints(data, minCount);
  if (points.length < 2) { minCount = 1; points = pickCurvePoints(data, 1); }

  const means = points.map((p) => p.mean);
  const labels = points.map((p) => p.pct + "%");

  buildChart("chart-curve", "line", {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Abertura média (mm)",
        data: means,
        borderColor: C.green,
        backgroundColor: C.greenFill,
        borderWidth: 2,
        pointBackgroundColor: "#ffffff",
        pointBorderColor: C.green,
        pointBorderWidth: 1.5,
        pointRadius: 3,
        pointHoverRadius: 5,
        tension: 0.35,
        fill: true,
      }],
    },
    options: lineOpts("Abertura (mm)", {
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => "Passante: " + items[0].label,
            label: (it) => fmtNum(it.parsed.y, 1) + " mm",
          },
        },
      },
    }),
  });
}

function pickCurvePoints(data, minCount) {
  return PERCENTILES
    .map((pct) => {
      const vals = data.map((r) => r.curve[pct]).filter((v) => v != null);
      if (vals.length < minCount) return null;
      return { pct, mean: vals.reduce((a, b) => a + b, 0) / vals.length };
    })
    .filter(Boolean)
    .sort((a, b) => a.pct - b.pct);
}
function renderHist(data) {
  const buckets = [
    { lo: 0, hi: 200, label: "0–200" },
    { lo: 200, hi: 300, label: "200–300" },
    { lo: 300, hi: 400, label: "300–400" },
    { lo: 400, hi: 500, label: "400–500" },
    { lo: 500, hi: 700, label: "500–700" },
    { lo: 700, hi: 1100, label: "700+" },
  ];
  const counts = buckets.map((b) =>
    data.filter((r) => r.d80 >= b.lo && r.d80 < b.hi).length
  );
  const colors = buckets.map((b) => (b.hi <= META_D80 + 1 ? C.green : C.neutral));

  buildChart("chart-hist", "bar", {
    type: "bar",
    data: {
      labels: buckets.map((b) => b.label),
      datasets: [{
        label: "Desmontes",
        data: counts,
        backgroundColor: colors,
        borderRadius: 6,
        maxBarThickness: 56,
      }],
    },
    options: barOpts("Nº de desmontes"),
  });
}

// --- D80 por desmonte vs meta ---
function renderD80(data) {
  const ordered = [...data].sort((a, b) => sortDate(a, b));
  const labels = ordered.map((r) => labelRec(r));
  const values = ordered.map((r) => r.d80);
  const meta = ordered.map((r) => r.meta || META_D80);
  const colors = values.map((v) => (v <= META_D80 ? C.green : C.neutral));

  buildChart("chart-d80", "bar", {
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "D80 (mm)",
          data: values,
          backgroundColor: colors,
          order: 2,
        },
        {
          type: "line",
          label: "Meta 400 mm",
          data: meta,
          borderColor: C.meta,
          borderWidth: 1.5,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false,
          order: 1,
        },
      ],
    },
    options: barOpts("D80 (mm)", {
      plugins: {
        legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 14 } },
        tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${fmtNum(it.parsed.y, 1)} mm` } },
      },
      scales: {
        x: scaleTicks(),
        y: scaleY("D80 (mm)"),
      },
    }),
  });
}

// --- D80 médio por banco ---
function renderBench(data) {
  const groups = {};
  data.forEach((r) => {
    if (r.banco == null) return;
    (groups[r.banco] = groups[r.banco] || []).push(r.d80);
  });
  const entries = Object.entries(groups)
    .map(([b, arr]) => ({ b: +b, mean: arr.reduce((a, c) => a + c, 0) / arr.length, n: arr.length }))
    .sort((a, b) => a.b - b.b);

  buildChart("chart-bench", "bar", {
    type: "bar",
    data: {
      labels: entries.map((e) => "Bco " + fmtInt(e.b)),
      datasets: [{
        label: "D80 médio (mm)",
        data: entries.map((e) => e.mean),
        backgroundColor: entries.map((e) => (e.mean <= META_D80 ? C.green : C.neutral)),
        borderRadius: 6,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (it) => `D80 médio: ${fmtNum(it.parsed.x, 0)} mm` } },
        annotation: false,
      },
      scales: {
        x: scaleY("D80 médio (mm)"),
        y: { ...scaleTicks(), grid: { display: false } },
      },
    },
  });
}

// --- Evolução temporal (média mensal) ---
function renderTrend(data) {
  const groups = {};
  data.forEach((r) => {
    if (!r.ano || !r.mes) return;
    const k = r.ano + "-" + String(r.mes).padStart(2, "0");
    (groups[k] = groups[k] || []).push(r.d80);
  });
  const keys = Object.keys(groups).sort();
  const means = keys.map((k) => {
    const arr = groups[k];
    return arr.reduce((a, c) => a + c, 0) / arr.length;
  });
  const labels = keys.map((k) => {
    const [y, m] = k.split("-");
    return meses[+m - 1] + "/" + y.slice(2);
  });

  buildChart("chart-trend", "line", {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "D80 médio mensal (mm)",
        data: means,
        borderColor: C.green,
        backgroundColor: C.greenFill,
        borderWidth: 2,
        pointBackgroundColor: "#ffffff",
        pointBorderColor: C.green,
        pointBorderWidth: 1.5,
        pointRadius: 3,
        tension: 0.3,
        fill: true,
      }, {
        type: "line",
        label: "Meta 400 mm",
        data: labels.map(() => META_D80),
        borderColor: C.meta,
        borderWidth: 1.5,
        borderDash: [5, 4],
        pointRadius: 0,
        fill: false,
      }],
    },
    options: lineOpts("D80 médio (mm)", {
      plugins: {
        legend: { display: true, position: "bottom", labels: { color: C.text, boxWidth: 14 } },
      },
    }),
  });
}

// ---------- Helpers de gráfico ----------
function buildChart(canvasId, _kind, config) {
  if (CHARTS[canvasId]) CHARTS[canvasId].destroy();
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  CHARTS[canvasId] = new Chart(ctx, config);
}

const meses = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function sortDate(a, b) {
  const ka = (a.ano || 0) * 100 + (a.mes || 0);
  const kb = (b.ano || 0) * 100 + (b.mes || 0);
  return ka - kb;
}
function labelRec(r) {
  const p = r.poligonal ? String(r.poligonal).slice(0, 6) : "—";
  return p;
}

function baseOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: tooltipBase(),
    },
  };
}
function tooltipBase() {
  return {
    backgroundColor: "#ffffff",
    titleColor: C.ink,
    bodyColor: C.ink,
    borderColor: C.grid,
    borderWidth: 1,
    padding: 10,
    cornerRadius: 2,
    displayColors: false,
    titleFont: { weight: "600", size: 12 },
    bodyFont: { size: 12 },
  };
}
function lineOpts(yTitle, extra = {}) {
  return deepMerge(baseOpts(), {
    plugins: extra.plugins || {},
    scales: {
      x: { ...scaleTicks(), grid: { display: false } },
      y: scaleY(yTitle),
    },
    elements: { line: { borderJoinStyle: "round" } },
  });
}
function barOpts(yTitle, extra = {}) {
  return deepMerge(baseOpts(), {
    plugins: extra.plugins || {},
    scales: { x: scaleTicks(), y: scaleY(yTitle) },
  });
}
function scaleTicks() {
  return { ticks: { color: C.text, font: { size: 11 } }, border: { color: C.grid } };
}
function scaleY(title) {
  return {
    title: { display: !!title, text: title, color: C.text, font: { size: 11, weight: "bold" } },
    ticks: { color: C.text, font: { size: 11 } },
    grid: { color: C.grid },
    border: { color: C.grid },
  };
}
function deepMerge(a, b) {
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const k in b) {
    if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) out[k] = deepMerge(a[k] || {}, b[k]);
    else out[k] = b[k];
  }
  return out;
}

// ---------- Status ----------
function setStatus(kind, text) {
  const el = document.getElementById("status");
  if (!el) return;
  el.classList.remove("is-loading", "is-ok", "is-error");
  if (kind === "loading") el.classList.add("is-loading");
  if (kind === "ok") el.classList.add("is-ok");
  if (kind === "error") el.classList.add("is-error");
  const t = document.getElementById("status-text");
  if (t) t.textContent = text;
}
function nowBR() {
  const d = new Date();
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

// ---------- Boot ----------
document.addEventListener("DOMContentLoaded", () => {
  if (!window.Chart) {
    setStatus("error", "Biblioteca de gráficos (Chart.js) não carregou. Verifique sua conexão.");
    return;
  }
  // Defaults globais — visual clean
  Chart.defaults.font.family = "'Helvetica Neue', Helvetica, Arial, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = C.text;
  Chart.defaults.borderColor = C.grid;
  Chart.defaults.plugins.tooltip = tooltipBase();
  loadSheet().catch((e) => console.error(e));
  // Revalida a cada 10 min enquanto a aba ficar aberta
  setInterval(() => loadSheet().catch(() => {}), 10 * 60 * 1000);
});
