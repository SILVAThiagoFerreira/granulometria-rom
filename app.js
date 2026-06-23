/* =====================================================================
   Granulometria do Material Desmontado (ROM) — US Vale Verde
   Lê em tempo real a planilha Google Sheets (gviz) e renderiza os gráficos.
   Atualiza a cada acesso — sem servidor, sem build.
   ===================================================================== */

const SHEET_ID = "1YZ8g4pAOcfiktvysQvdlRwVcLvVnZrz_";
const GVIZ_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&headers=1`;
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
const META_D80 = 400;

const C = {
  green: "#38424B",
  greenFill: "rgba(56,66,75,0.09)",
  neutral: "#E20613",
  meta: "#aab0b6",
  grid: "rgba(56,66,75,0.10)",
  text: "#6c747b",
  ink: "#38424B",
};

const guideLinePlugin = {
  id: "guideLine",
  afterDraw(chart) {
    const active = chart.getActiveElements();
    if (!active.length) return;
    const a = active[0];
    const el = chart.getDatasetMeta(a.datasetIndex).data[a.index];
    if (!el) return;
    const ctx = chart.ctx;
    const horizontal = chart.options.indexAxis === "y";
    const area = chart.chartArea;
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = "rgba(56,66,75,0.30)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    if (horizontal) { ctx.moveTo(area.left, el.y); ctx.lineTo(area.right, el.y); }
    else { ctx.moveTo(el.x, area.top); ctx.lineTo(el.x, area.bottom); }
    ctx.stroke();
    ctx.restore();
  },
};

const norm = (s) =>
  (s || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/\s+/g, " ").trim();

const fmtInt = (n) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(n || 0);
const fmtNum = (n, d = 0) =>
  new Intl.NumberFormat("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);

const escapeText = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) => escapeText(s).replace(/"/g, "&quot;");

const parseDateCell = (v) => {
  if (!v) return null;
  const m = String(v).match(/Date\((\d+),(\d+),(\d+)/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2] + 1, d: +m[3] };
};

let RECORDS = [];
let CHARTS = {};

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
      setStatus("error", "Nao foi possivel acessar a planilha. Verifique se o link esta publico.");
      throw e2;
    }
  }
  RECORDS = buildRecords(table);
  if (!RECORDS.length) {
    setStatus("error", "Planilha acessada, mas nenhum registro encontrado.");
    return;
  }
  populateFilters();
  setStatus("ok", `${RECORDS.length} desmontes carregados.`);
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

    const dt = parseDateCell(cell(f.data));
    const ano = num(cell(f.ano)) || (dt ? dt.y : null);
    const mes = num(cell(f.mes)) || (dt ? dt.mo : null);

    const curve = {};
    for (const cc of curveCols) {
      const v = num(cell(cc.i));
      if (v != null) curve[cc.pct] = v;
    }
    if (!Object.keys(curve).length && d80 == null) continue;

    recs.push({
      poligonal: cell(f.poligonal),
      banco: num(cell(f.banco)),
      ano, mes, date: dt,
      massa: num(cell(f.massa)) || 0,
      volume: num(cell(f.volume)) || 0,
      d80: d80 ?? curve[80] ?? null,
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

function populateFilters() {
  const years = [...new Set(RECORDS.map((r) => r.ano).filter(Boolean))].sort();
  const benches = [...new Set(RECORDS.map((r) => r.banco).filter((v) => v != null))].sort((a, b) => a - b);
  const plans = [...new Set(RECORDS.map((r) => r.poligonal).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));

  const ySel = document.getElementById("filter-year");
  const mSel = document.getElementById("filter-month");
  const bSel = document.getElementById("filter-bench");
  const pSel = document.getElementById("filter-plan");

  ySel.innerHTML = `<option value="">Todos os anos</option>` +
    years.map((y) => `<option value="${y}">${y}</option>`).join("");
  mSel.innerHTML = `<option value="">Todos os meses</option>` +
    meses.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  bSel.innerHTML = `<option value="">Todos os bancos</option>` +
    benches.map((b) => `<option value="${b}">Banco ${fmtInt(b)}</option>`).join("");
  pSel.innerHTML = `<option value="">Todos os planos</option>` +
    plans.map((p) => `<option value="${escapeAttr(p)}">${escapeText(p)}</option>`).join("");

  [ySel, mSel, bSel, pSel].forEach((s) => (s.onchange = render));
  document.getElementById("filter-reset").onclick = () => {
    ySel.value = ""; mSel.value = ""; bSel.value = ""; pSel.value = "";
    render();
  };
}

function filtered() {
  const y = document.getElementById("filter-year").value;
  const mo = document.getElementById("filter-month").value;
  const b = document.getElementById("filter-bench").value;
  const p = document.getElementById("filter-plan").value;
  return RECORDS.filter((r) =>
    (!y || String(r.ano) === y) &&
    (!mo || String(r.mes) === mo) &&
    (!b || String(r.banco) === b) &&
    (!p || String(r.poligonal) === p)
  );
}

function availablePercentiles(data = RECORDS) {
  return [...new Set(
    data.flatMap((r) => Object.keys(r.curve || {}).map((pct) => +pct).filter(Number.isFinite))
  )].sort((a, b) => a - b);
}

function metricVals(data, pct) {
  return data.map((r) => r.curve[pct]).filter((v) => v != null);
}

function render() {
  const data = filtered();
  renderKpis(data);
  renderCurve(data);
  renderTrendAll(data);
  updateActiveFilters();
}

const FILTER_DEFS = [
  { id: "filter-year", label: "Ano" },
  { id: "filter-month", label: "Mes", name: (v) => meses[+v - 1] },
  { id: "filter-bench", label: "Banco", name: (v) => "Bco " + fmtInt(+v) },
  { id: "filter-plan", label: "Plano" },
];

function updateActiveFilters() {
  const box = document.getElementById("active-filters");
  if (!box) return;
  const chips = [];
  FILTER_DEFS.forEach((f) => {
    const sel = document.getElementById(f.id);
    if (sel && sel.value) {
      const display = f.name ? f.name(sel.value) : sel.value;
      chips.push(
        `<button class="chip" data-id="${f.id}" type="button">` +
        `<span class="chip__k">${f.label}:</span> <span class="chip__v">${escapeText(display)}</span>` +
        `<span class="chip__x" aria-hidden="true">&times;</span></button>`
      );
    }
  });
  box.innerHTML = chips.join("");
  box.style.display = chips.length ? "" : "none";
  box.querySelectorAll(".chip").forEach((btn) => {
    btn.onclick = () => {
      const s = document.getElementById(btn.dataset.id);
      if (s) s.value = "";
      render();
    };
  });
}

function renderKpis(data) {
  const d80s = data.map((r) => r.d80).filter((v) => v != null);
  const mean = d80s.length ? d80s.reduce((a, b) => a + b, 0) / d80s.length : 0;
  const conf = d80s.filter((v) => v <= META_D80).length;
  const mass = data.reduce((a, r) => a + (r.massa || 0), 0);

  document.getElementById("kpi-count").textContent = fmtInt(data.length);
  document.getElementById("kpi-count-hint").textContent =
    data.length ? `${fmtInt(data.length)} desmontes no filtro` : " ";
  document.getElementById("kpi-d80").textContent = fmtNum(mean, 0) + " mm";
  const confPct = d80s.length ? (conf / d80s.length) * 100 : 0;
  const confEl = document.getElementById("kpi-conf");
  confEl.textContent = fmtNum(confPct, 0) + "%";
  confEl.style.color = "";
  document.getElementById("kpi-conf-hint").textContent = `${fmtInt(conf)} de ${fmtInt(d80s.length)} dentro da meta`;
  document.getElementById("kpi-mass").textContent = fmtNum(mass / 1000, 0) + " kt";
  document.getElementById("kpi-mass-hint").textContent = fmtInt(mass) + " t desmontadas";
}

function renderCurve(data) {
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
        label: "Abertura media (mm)",
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
  return availablePercentiles(data)
    .map((pct) => {
      const vals = data.map((r) => r.curve[pct]).filter((v) => v != null);
      if (vals.length < minCount) return null;
      return { pct, mean: vals.reduce((a, b) => a + b, 0) / vals.length };
    })
    .filter(Boolean)
    .sort((a, b) => a.pct - b.pct);
}

const LINE_COLORS = [
  "#38424B", "#E20613", "#5a6670", "#c4302b",
  "#7a868f", "#ff6b6b", "#2c3e50", "#e74c3c",
  "#95a5a6", "#d35400", "#bdc3c7", "#2980b9",
  "#1abc9c",
];

function renderTrendAll(data) {
  const pcts = availablePercentiles(data);
  const groups = {};
  data.forEach((r) => {
    if (!r.ano || !r.mes) return;
    const k = r.ano + "-" + String(r.mes).padStart(2, "0");
    if (!groups[k]) groups[k] = {};
    for (const pct of pcts) {
      const v = r.curve[pct];
      if (v != null) {
        if (!groups[k][pct]) groups[k][pct] = [];
        groups[k][pct].push(v);
      }
    }
  });
  const keys = Object.keys(groups).sort();
  const labels = keys.map((k) => {
    const [y, m] = k.split("-");
    return meses[+m - 1] + "/" + y.slice(2);
  });

  const datasets = pcts.map((pct, ci) => ({
    label: "P" + pct,
    data: keys.map((k) => {
      const arr = groups[k][pct];
      return arr ? arr.reduce((a, c) => a + c, 0) / arr.length : null;
    }),
    borderColor: LINE_COLORS[ci % LINE_COLORS.length],
    backgroundColor: "transparent",
    borderWidth: pct === 80 ? 2.5 : 1.5,
    borderDash: pct === 80 ? [] : [4, 3],
    pointRadius: pct === 80 ? 3 : 1.5,
    pointHoverRadius: 5,
    tension: 0.3,
    fill: false,
  }));

  buildChart("chart-trend-all", "line", {
    type: "line",
    data: { labels, datasets },
    options: lineOpts("Media mensal (mm)", {
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: { color: C.text, boxWidth: 14, font: { size: 10 } },
        },
      },
    }),
  });
}

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
  const p = r.poligonal ? String(r.poligonal).slice(0, 6) : "-";
  return p;
}

function baseOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    hover: { mode: "index", intersect: false },
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

document.addEventListener("DOMContentLoaded", () => {
  if (!window.Chart) {
    setStatus("error", "Biblioteca de graficos (Chart.js) nao carregou. Verifique sua conexao.");
    return;
  }
  Chart.defaults.font.family = "'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = C.text;
  Chart.defaults.borderColor = C.grid;
  Chart.defaults.plugins.tooltip = tooltipBase();
  Chart.register(guideLinePlugin);
  loadSheet().catch((e) => console.error(e));
  setInterval(() => loadSheet().catch(() => {}), 10 * 60 * 1000);
});
