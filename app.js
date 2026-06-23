/* =====================================================================
   Granulometria do Material Desmontado (ROM) — US Vale Verde
   Lê em tempo real a planilha Google Sheets (gviz) e renderiza os gráficos.
   Atualiza a cada acesso — sem servidor, sem build.
   ===================================================================== */

const SHEET_ID = "1YZ8g4pAOcfiktvysQvdlRwVcLvVnZrz_";
const GVIZ_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&headers=1`;
const CSV_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
const META_D80 = 400; // mm — meta de D80 da operação

// ---------- Paleta Enaex (cinza + vermelho sobre branco) ----------
const C = {
  green: "#38424B",        // conforme / dados (Cinza Enaex)
  greenFill: "rgba(56,66,75,0.09)",
  neutral: "#E20613",      // não-conforme / acima da meta (Vermelho Enaex)
  meta: "#aab0b6",         // linha de meta (cinza claro)
  grid: "rgba(56,66,75,0.10)",
  text: "#6c747b",
  ink: "#38424B",
};

// ---------- Plugin: linha-guia (crosshair) ao passar o mouse ----------
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

// ---------- Utilitários ----------
const norm = (s) =>
  (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "")
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

// ---------- Filtros ----------
function populateFilters() {
  const years = [...new Set(RECORDS.map((r) => r.ano).filter(Boolean))].sort();
  const benches = [...new Set(RECORDS.map((r) => r.banco).filter((v) => v != null))].sort((a, b) => a - b);
  const plans = [...new Set(RECORDS.map((r) => r.poligonal).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));

  const ySel = document.getElementById("filter-year");
  const mSel = document.getElementById("filter-month");
  const bSel = document.getElementById("filter-bench");
  const pSel = document.getElementById("filter-plan");
  const metSel = document.getElementById("filter-metric");
  const percentiles = availablePercentiles();

  ySel.innerHTML = `<option value="">Todos os anos</option>` +
    years.map((y) => `<option value="${y}">${y}</option>`).join("");
  mSel.innerHTML = `<option value="">Todos os meses</option>` +
    meses.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  bSel.innerHTML = `<option value="">Todos os bancos</option>` +
    benches.map((b) => `<option value="${b}">Banco ${fmtInt(b)}</option>`).join("");
  pSel.innerHTML = `<option value="">Todos os planos</option>` +
    plans.map((p) => `<option value="${escapeAttr(p)}">${escapeText(p)}</option>`).join("");
  const currentMetric = metSel.value;
  metSel.innerHTML = percentiles.map((pct) =>
    `<option value="${pct}"${String(pct) === String(currentMetric || 80) ? " selected" : ""}>P${pct}</option>`
  ).join("");
  if (!metSel.value && percentiles.length) {
    metSel.value = String(percentiles.includes(80) ? 80 : percentiles[0]);
  }
  [ySel, mSel, bSel, pSel, metSel].forEach((s) => (s.onchange = render));
  document.getElementById("filter-reset").onclick = () => {
    ySel.value = ""; mSel.value = ""; bSel.value = ""; pSel.value = "";
    metSel.value = String(percentiles.includes(80) ? 80 : (percentiles[0] ?? 80));
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

// Percentil selecionado a partir das colunas Dxx disponíveis na base.
function currentPct() {
  return parseInt(document.getElementById("filter-metric").value, 10) || 80;
}
const hasMeta = (pct) => pct === 80;
function availablePercentiles(data = RECORDS) {
  return [...new Set(
    data.flatMap((r) => Object.keys(r.curve || {}).map((pct) => +pct).filter(Number.isFinite))
  )].sort((a, b) => a - b);
}
// valores do percentil informado, entre os registros do filtro
function metricVals(data, pct) {
  return data.map((r) => r.curve[pct]).filter((v) => v != null);
}

// ---------- Render ----------
function render() {
  const data = filtered();
  const pct = currentPct();
  const tag = "P" + pct;
  setText("title-dist", "Distribuição " + tag);
  setText("title-peritem", tag + " por desmonte");
  setText("sub-peritem", hasMeta(pct) ? "Linha: meta 400 mm · clique para filtrar por plano" : "Clique para filtrar por plano");
  setText("title-bench", tag + " médio por banco");
  setText("title-trend", "Evolução " + tag);
  renderKpis(data, pct);
  renderCurve(data);
  renderHist(data, pct);
  renderPerItem(data, pct);
  renderBench(data, pct);
  renderTrend(data, pct);
  updateActiveFilters();
}

function setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

// ---------- Chips de filtros ativos ----------
const FILTER_DEFS = [
  { id: "filter-year", label: "Ano" },
  { id: "filter-month", label: "Mês", name: (v) => meses[+v - 1] },
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
        `<span class="chip__x" aria-hidden="true">×</span></button>`
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

function renderKpis(data, pct) {
  const vals = metricVals(data, pct);
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const mass = data.reduce((a, r) => a + (r.massa || 0), 0);
  const tag = "P" + pct;

  document.getElementById("kpi-count").textContent = fmtInt(data.length);
  document.getElementById("kpi-count-hint").textContent =
    data.length ? `${fmtInt(data.length)} desmontes no filtro` : " ";
  setText("kpi-d80-label", tag + " médio");
  document.getElementById("kpi-d80").textContent = fmtNum(mean, 0) + " mm";
  setText("kpi-d80-sub", vals.length ? `${fmtInt(vals.length)} com dado de ${tag}` : "—");

  const confEl = document.getElementById("kpi-conf");
  if (hasMeta(pct)) {
    setText("kpi-conf-label", "Conformidade " + tag);
    const conf = vals.filter((v) => v <= META_D80).length;
    const confPct = vals.length ? (conf / vals.length) * 100 : 0;
    confEl.textContent = fmtNum(confPct, 0) + "%";
    confEl.style.color = confPct >= 70 ? C.green : C.neutral;
    document.getElementById("kpi-conf-hint").textContent = `${fmtInt(conf)} de ${fmtInt(vals.length)} dentro da meta`;
  } else {
    setText("kpi-conf-label", "Faixa (min–máx)");
    const min = vals.length ? Math.min(...vals) : 0;
    const max = vals.length ? Math.max(...vals) : 0;
    confEl.textContent = vals.length ? `${fmtNum(min, 0)}–${fmtNum(max, 0)}` : "—";
    confEl.style.color = C.ink;
    document.getElementById("kpi-conf-hint").textContent = vals.length ? `amplitude de ${tag} (mm)` : "—";
  }
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
  return availablePercentiles(data)
    .map((pct) => {
      const vals = data.map((r) => r.curve[pct]).filter((v) => v != null);
      if (vals.length < minCount) return null;
      return { pct, mean: vals.reduce((a, b) => a + b, 0) / vals.length };
    })
    .filter(Boolean)
    .sort((a, b) => a.pct - b.pct);
}
function renderHist(data, pct) {
  const vals = metricVals(data, pct);
  // P80 usa faixas fixas (centradas na meta de 400); demais usam faixas adaptativas
  const buckets = (hasMeta(pct) && vals.length)
    ? [
        { lo: 0, hi: 200, label: "0–200" },
        { lo: 200, hi: 300, label: "200–300" },
        { lo: 300, hi: 400, label: "300–400" },
        { lo: 400, hi: 500, label: "400–500" },
        { lo: 500, hi: 700, label: "500–700" },
        { lo: 700, hi: Infinity, label: "700+" },
      ]
    : adaptiveBins(vals);

  const counts = buckets.map((b, i) =>
    vals.filter((v) => v >= b.lo && (i === buckets.length - 1 ? v <= b.hi : v < b.hi)).length
  );
  const colors = buckets.map((b) => (hasMeta(pct) && b.hi <= META_D80 + 1 ? C.green : (hasMeta(pct) ? C.neutral : C.green)));
  const hover = buckets.map((b) => (hasMeta(pct) && b.hi <= META_D80 + 1 ? "#2b333a" : (hasMeta(pct) ? "#b80510" : "#2b333a")));

  buildChart("chart-hist", "bar", {
    type: "bar",
    data: {
      labels: buckets.map((b) => b.label),
      datasets: [{
        label: "Desmontes",
        data: counts,
        backgroundColor: colors,
        hoverBackgroundColor: hover,
        borderRadius: 3,
        maxBarThickness: 56,
      }],
    },
    options: barOpts("Nº de desmontes"),
  });
}

// Faixas adaptativas ("nice bins") com base no intervalo dos dados
function adaptiveBins(vals) {
  if (!vals.length) return [{ lo: 0, hi: 1, label: "—" }];
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const n = 6;
  const raw = (max - min) / n || 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const base = raw / pow;
  const nice = (base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10) * pow;
  const lo = Math.floor(min / nice) * nice;
  const bins = [];
  for (let i = 0; i <= n; i++) {
    const a = lo + i * nice;
    bins.push({ lo: a, hi: a + nice, label: fmtNum(a, 0) + "–" + fmtNum(a + nice, 0) });
  }
  return bins;
}

// --- P{X} por desmonte (meta 400 só em P80) ---
function renderPerItem(data, pct) {
  const tag = "P" + pct;
  const meta = hasMeta(pct);
  const ordered = [...data].sort((a, b) => sortDate(a, b));
  const labels = ordered.map((r) => labelRec(r));
  const values = ordered.map((r) => r.curve[pct]);
  const barColors = values.map((v) => (meta ? (v <= META_D80 ? C.green : C.neutral) : C.green));
  const barHover = values.map(() => "#2b333a");

  const datasets = [{
    type: "bar",
    label: tag + " (mm)",
    data: values,
    backgroundColor: barColors,
    hoverBackgroundColor: meta ? values.map((v) => (v <= META_D80 ? "#2b333a" : "#b80510")) : barHover,
    order: 2,
  }];
  if (meta) {
    datasets.push({
      type: "line",
      label: "Meta 400 mm",
      data: values.map(() => META_D80),
      borderColor: C.meta,
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      fill: false,
      order: 1,
    });
  }

  buildChart("chart-d80", "bar", {
    data: { labels, datasets },
    options: barOpts(tag + " (mm)", {
      plugins: {
        legend: { display: meta, position: "bottom", labels: { color: C.text, boxWidth: 14 } },
        tooltip: {
          callbacks: {
            title: (items) => {
              const r = ordered[items[0].dataIndex];
              return "Plano " + (r.poligonal || "—");
            },
            label: (it) => {
              if (it.dataset.type === "line") return "Meta: " + fmtNum(it.parsed.y, 0) + " mm";
              const r = ordered[it.dataIndex];
              const v = r.curve[pct];
              const status = meta ? (v <= META_D80 ? "✓ dentro da meta" : "✗ acima da meta") : null;
              const lines = [`${tag}: ${v != null ? fmtNum(v, 1) : "—"} mm`, `Banco: ${r.banco != null ? fmtInt(r.banco) : "—"}`];
              if (status) lines.push(status);
              return lines;
            },
          },
        },
      },
      scales: {
        x: scaleTicks(),
        y: scaleY(tag + " (mm)"),
      },
    }),
  });
  // clique numa barra -> filtra por plano (poligonal)
  const dc = CHARTS["chart-d80"];
  if (dc) {
    dc.options.onClick = (_evt, els) => {
      if (!els.length) return;
      const r = ordered[els[0].index];
      const sel = document.getElementById("filter-plan");
      sel.value = String(r.poligonal);
      render();
    };
    dc.options.onHover = (evt, els) => {
      if (evt.native && evt.native.target) evt.native.target.style.cursor = els.length ? "pointer" : "default";
    };
  }
}

// --- P{X} médio por banco ---
function renderBench(data, pct) {
  const tag = "P" + pct;
  const meta = hasMeta(pct);
  const groups = {};
  data.forEach((r) => {
    if (r.banco == null) return;
    const value = r.curve[pct];
    if (value == null) return;
    (groups[r.banco] = groups[r.banco] || []).push(value);
  });
  const entries = Object.entries(groups)
    .map(([b, arr]) => ({ b: +b, mean: arr.reduce((a, c) => a + c, 0) / arr.length, n: arr.length }))
    .sort((a, b) => a.b - b.b);

  buildChart("chart-bench", "bar", {
    type: "bar",
    data: {
      labels: entries.map((e) => "Bco " + fmtInt(e.b)),
      datasets: [{
        label: `${tag} médio (mm)`,
        data: entries.map((e) => e.mean),
        backgroundColor: entries.map((e) => (meta ? (e.mean <= META_D80 ? C.green : C.neutral) : C.green)),
        hoverBackgroundColor: entries.map((e) => (meta ? (e.mean <= META_D80 ? "#2b333a" : "#b80510") : "#2b333a")),
        borderRadius: 3,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: true },
      onClick: (_evt, els) => {
        if (!els.length) return;
        const e = entries[els[0].index];
        const sel = document.getElementById("filter-bench");
        sel.value = String(e.b);
        render();
      },
      onHover: (evt, els) => {
        if (evt.native && evt.native.target) {
          evt.native.target.style.cursor = els.length ? "pointer" : "default";
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (it) => `${tag} médio: ${fmtNum(it.parsed.x, 0)} mm · clique para filtrar` } },
      },
      scales: {
        x: scaleY(`${tag} médio (mm)`),
        y: { ...scaleTicks(), grid: { display: false } },
      },
    },
  });
}

// --- Evolução temporal (média mensal) ---
function renderTrend(data, pct) {
  const tag = "P" + pct;
  const meta = hasMeta(pct);
  const groups = {};
  data.forEach((r) => {
    if (!r.ano || !r.mes) return;
    const value = r.curve[pct];
    if (value == null) return;
    const k = r.ano + "-" + String(r.mes).padStart(2, "0");
    (groups[k] = groups[k] || []).push(value);
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
  const datasets = [{
    label: `${tag} médio mensal (mm)`,
    data: means,
    borderColor: C.green,
    backgroundColor: C.greenFill,
    borderWidth: 2,
    pointBackgroundColor: "#ffffff",
    pointBorderColor: C.green,
    pointBorderWidth: 1.5,
    pointRadius: 3,
    pointHoverRadius: 6,
    tension: 0.3,
    fill: true,
  }];
  if (meta) {
    datasets.push({
      type: "line",
      label: "Meta 400 mm",
      data: labels.map(() => META_D80),
      borderColor: C.meta,
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      fill: false,
    });
  }

  buildChart("chart-trend", "line", {
    type: "line",
    data: {
      labels,
      datasets,
    },
    options: lineOpts(`${tag} médio (mm)`, {
      plugins: {
        legend: { display: meta, position: "bottom", labels: { color: C.text, boxWidth: 14 } },
      },
    }),
  });
  // clique no ponto → filtra por ano + mês
  const tc = CHARTS["chart-trend"];
  if (tc) {
    tc.options.onClick = (_evt, els) => {
      if (!els.length) return;
      const k = keys[els[0].index].split("-");
      document.getElementById("filter-year").value = k[0];
      document.getElementById("filter-month").value = String(+k[1]);
      render();
    };
    tc.options.onHover = (evt, els) => {
      if (evt.native && evt.native.target) {
        evt.native.target.style.cursor = els.length ? "pointer" : "default";
      }
    };
  }
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
  Chart.defaults.font.family = "'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = C.text;
  Chart.defaults.borderColor = C.grid;
  Chart.defaults.plugins.tooltip = tooltipBase();
  Chart.register(guideLinePlugin);
  loadSheet().catch((e) => console.error(e));
  // Revalida a cada 10 min enquanto a aba ficar aberta
  setInterval(() => loadSheet().catch(() => {}), 10 * 60 * 1000);
});
