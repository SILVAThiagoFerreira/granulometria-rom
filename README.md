# Granulometria do Material Desmontado (ROM) — US Vale Verde

Dashboard estático de granulometria do material desmontado (ROM) da **US Vale Verde**.
Visual Enaex (verde institucional + lime), integrado ao hub de dashboards.

🔗 **Online:** <https://silvathiagoferreira.github.io/granulometria-rom/>

## Como funciona

- **100% estático** (HTML + CSS + JS, sem build).
- Lê os dados **em tempo real** da planilha Google Sheets da operação, diretamente
  no navegador (API gviz). Por isso **atualiza sozinho a cada acesso** — não depende
  de servidor, cron ou do PC estar ligado.
- Gráficos com [Chart.js](https://www.chartjs.org/) via CDN.
- Hospedado em **GitHub Pages** (deploy automático via Actions a cada `push` na `main`).

## Indicadores

- KPIs: desmontes analisados, D80 médio, % de conformidade (D80 ≤ 400 mm), massa desmontada.
- Curva granulométrica média (passante acumulado por abertura).
- Distribuição do D80 por faixa.
- D80 por desmonte vs meta (400 mm).
- D80 médio por banco.
- Evolução mensal do D80.
- Filtros por **ano** e **banco**.

## Fonte de dados

Planilha Google Sheets (compartilhada via link). O ID da planilha está em `app.js`
(constante `SHEET_ID`). A planilha precisa permanecer compartilhada como "Qualquer
pessoa com o link" para o dashboard continuar lendo os dados.

## Desenvolvimento local

É só servir a pasta (precisa de um servidor para evitar bloqueio CORS do `fetch`):

```bash
python -m http.server 8000
# abra http://localhost:8000
```

## Estrutura

```
index.html        # marcação do dashboard
styles.css        # visual Enaex
app.js            # leitura da planilha + gráficos
assets/           # logos OpenBlast + Enaex
.github/workflows/deploy-pages.yml  # deploy GitHub Pages
.nojekyll
```
