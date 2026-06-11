# GPX Navigator Pro — Formato de Dados (v23+)

Referência para gerar arquivos carregáveis no app a partir de scripts externos
(ex.: conversor MF4/MAT → JSON/GPX em Python). O app aceita dois formatos.

---

## 1. JSON (formato nativo — fidelidade total)

É o formato interno das gravações. Suporta fotos e eventos. Carregável via
**📥 Import JSON** (aba Recordings) ou pelo botão **📂** da topbar.

### Estrutura

```json
[
  {
    "name": "Ciclo P9781 Volta Norte",
    "date": "2026-06-10T08:30:00.000Z",
    "dist": 12.45,
    "points": [
      { "lat": 57.708870, "lng": 11.974560, "t": 1749544200000 },
      { "lat": 57.708912, "lng": 11.974601, "t": 1749544201000 }
    ],
    "stops": [
      {
        "lat": 57.710210, "lng": 11.976300,
        "t": 1749544260000,
        "dur_s": 45,
        "events": ["openDoor", "kneeling"],
        "photo": null
      }
    ]
  }
]
```

### Regras e tolerâncias do import

| Campo | Obrigatório | Notas |
|---|---|---|
| raiz | — | Array de gravações **ou** objeto único (é embrulhado automaticamente) |
| `name` | não | Default `"Imported route"` |
| `date` | não | ISO 8601; default = agora |
| `dist` | não | km; **calculado dos points se ausente** |
| `points[]` | sim, ≥ 2 | `lat` + `lng` **ou** `lon` (ambos aceitos) |
| `points[].t` | não | epoch **ms** ou string ISO — ambos aceitos |
| `points[].alt` | não | altitude em metros; alias `ele` aceito — habilita ganho de elevação |
| `stops[]` | não | mesmas tolerâncias lat/lng/lon e t |
| `stops[].dur_s` | não | segundos planejados; alias `duracao_s` aceito; 0 = sem tempo planejado (sem auto-complete) |
| `stops[].events` | não | array com `"openDoor"` e/ou `"kneeling"` |
| `stops[].photo` | não | data URL `data:image/jpeg;base64,...` (≤ ~800px, qualidade 72% recomendado) ou `null` |

Campos calculados automaticamente se ausentes (não precisa gerar no script):
`score` (classificação GTA/VBC — Ci1-3, Co1-2, LH1-2 com critérios atendidos /5),
`elev` (ganho de elevação, requer `alt`/`ele` nos points) e `time_s` (duração).
A classificação GTA usa 5 critérios da tabela VBC: stops/km, velocidade média
total, velocidade de condução (sem idle), velocidade máxima e % de idle.

⚠️ `localStorage` tem limite de ~5 MB total — fotos grandes em muitos stops estouram a cota.
Para arquivos gerados por script, prefira `photo: null`.

### Exemplo mínimo válido

```json
{ "points": [ {"lat": 57.70, "lon": 11.97}, {"lat": 57.71, "lon": 11.97} ],
  "stops":  [ {"lat": 57.705, "lon": 11.97, "duracao_s": 30} ] }
```

---

## 2. GPX 1.1 (interoperável — sem fotos)

Carregável pelo botão **📂** ou drag-and-drop no mapa. Bom para troca com outras
ferramentas. O app lê e escreve as extensões abaixo.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="conversor_mf4_gpx.py">
  <metadata><name>Ciclo P9781</name><time>2026-06-10T08:30:00Z</time></metadata>

  <!-- Paradas: wpt ANTES de trk (ordem do schema GPX) -->
  <wpt lat="57.71021000" lon="11.97630000">
    <name>Stop 1</name>
    <desc>Duration: 00:00:45 · openDoor</desc>
    <cmt>duracao_s=45</cmt>
    <duracao_s>45</duracao_s>
    <openDoor>1</openDoor>
    <kneeling>1</kneeling>
    <time>2026-06-10T08:31:00Z</time>
  </wpt>

  <trk><name>Ciclo P9781</name><trkseg>
    <trkpt lat="57.70887000" lon="11.97456000"><time>2026-06-10T08:30:00Z</time></trkpt>
    <trkpt lat="57.70891200" lon="11.97460100"><time>2026-06-10T08:30:01Z</time></trkpt>
  </trkseg></trk>
</gpx>
```

### Ordem de leitura do `dur_s` no parser
1. Elemento `<duracao_s>` (preferido para scripts)
2. `<cmt>duracao_s=N</cmt>`
3. `<desc>Duração: N min</desc>` (legado)

Eventos: elementos `<openDoor>` / `<kneeling>` **ou** as palavras no `<desc>`.

---

## 3. Recomendações para o conversor Python

- **Densidade do track**: 1 ponto/segundo é o ideal (igual à gravação nativa).
  Abaixo de ~1 ponto a cada 25 m a detecção de curvas (janela de 5 pontos) degrada.
- **Ordem dos stops** = ordem de visita no ciclo. A navegação é **sequencial**:
  só a próxima parada pendente dispara chegada (ciclos com voltas no mesmo
  ponto dependem disso).
- **Coordenadas**: WGS84 decimal, ≥ 6 casas (≈ 0,1 m).
- Voltas repetidas no mesmo ponto físico → **um stop por visita**, coordenadas
  podem ser idênticas.
- Validação rápida: `python -m json.tool arquivo.json` antes de importar.

---

## 4. Fluxo entre dispositivos

```
Tablet A (gravou)                       Tablet B / outro dispositivo
─────────────────                       ─────────────────────────────
Recordings → 📤 JSON (share sheet)  →   Recordings → 📥 Import JSON
         ou 📤 Export All (backup)  →   (ou 📂 na topbar, ou drag-drop .gpx)
         ou ↓ GPX (sem fotos)
```

O `localStorage` é por dispositivo/navegador — o JSON exportado é a fonte
portátil. **Export All** semanal recomendado como backup do tablet de campo.
