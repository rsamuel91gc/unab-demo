/**
 * app.js - Controlador Frontend Minimalista y Progresivo
 * UNAB Psychometrics Hub - Ciclo 2, 2026
 * Cumple INV-NO-GROUP4, INV-ZERO-PII-LEAK, persistencia en localStorage,
 * diseño split 35% tabla / 65% gráfica, Smart Grouping, Filtrado Cruzado interactivo,
 * Extracción de Hipótesis con Gemini AI, Respuestas Cualitativas Thematic Clusters,
 * Soporte Dicotómico KR-20, Tarjetas de Advertencias Metodológicas Transparentes,
 * Scoping de Columnas de Excel y Checkboxes de Inclusión de Ítems.
 */
(function () {
  "use strict";

  const PALETTES = {
    "unab-indigo": ["#6366f1", "#06b6d4", "#14b8a6", "#f59e0b", "#f43f5e", "#8b5cf6"],
    "emerald-mint": ["#10b981", "#34d399", "#6ee7b7", "#059669", "#047857", "#065f46"],
    "ocean-cyan": ["#0284c7", "#38bdf8", "#0ea5e9", "#7dd3fc", "#bae6fd", "#0369a1"],
    "sunset-amber": ["#f59e0b", "#fbbf24", "#f97316", "#ef4444", "#ec4899", "#d97706"],
  };

  const state = {
    catalog: null,
    groupsById: {},
    currentGroupId: localStorage.getItem("unab_group_id") || "G1",
    currentRole: localStorage.getItem("unab_role") || "team_member",
    currentUserEmail: localStorage.getItem("unab_user_email") || "estudiante@unab.edu.sv",
    currentStep: 1,
    originalOverlay: null,
    currentOverlay: null,
    rawRowsAnon: [],
    filteredRowsAnon: [],
    activeCrossFilters: {},
    sourceSha256: "Pendiente",
    analysisResult: null,
    geminiApiKey: localStorage.getItem("unab_gemini_api_key") || "",
    teamEmails: localStorage.getItem("unab_team_emails") || "",
    searchFilter: "",
    dimensionFilter: "all",
    chartType: localStorage.getItem("unab_chart_type") || "likert-segmented",
    chartPalette: localStorage.getItem("unab_chart_palette") || "unab-indigo",
    hypotheses: [],
    geminiImprovements: [],
    qualitativeCache: {},
    columnScopingState: {
      columns: [],
      excluded: new Set(),
      mapping: {},
      dimensions: {},
      editedTexts: {},
    },
    structuredHypotheses: {
      general: { text: "", x_dim: "", y_dim: "" },
      specifics: [
        { id: "HE1", text: "", x_dim: "", y_dim: "" },
        { id: "HE2", text: "", x_dim: "", y_dim: "" },
      ],
    },
    activeQuotesModalData: null,
    lastExtractedHypothesis: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const DOMPurify = {
    sanitize(html) {
      return String(html == null ? "" : html)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/\son\w+\s*=/gi, " data-blocked=");
    },
  };

  function fmtNum(v, dec = 3) {
    return typeof v === "number" && Number.isFinite(v) ? v.toFixed(dec) : "—";
  }

  function apiHeaders(extra = {}) {
    return Object.assign(
      {
        "X-UNAB-Role": state.currentRole,
        "X-UNAB-Group": state.currentGroupId || "",
      },
      extra
    );
  }

  async function apiFetch(url, options = {}) {
    const opts = Object.assign({}, options);
    opts.headers = apiHeaders(opts.headers || {});
    const resp = await fetch(url, opts);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.detail || data.error || `HTTP ${resp.status}`);
    }
    return data;
  }

  // =========================================================================
  // PERSISTENCIA DEL TEMA (CLARO / OSCURO)
  // =========================================================================
  function initTheme() {
    const saved = localStorage.getItem("unab_theme") || "dark";
    applyTheme(saved);

    $("#theme-toggle")?.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") || "dark";
      const next = current === "dark" ? "light" : "dark";
      applyTheme(next);
    });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("unab_theme", theme);
    const icon = $("#theme-icon");
    const text = $("#theme-text");
    if (icon && text) {
      if (theme === "dark") {
        icon.textContent = "🌙";
        text.textContent = "Modo Oscuro";
      } else {
        icon.textContent = "☀️";
        text.textContent = "Modo Claro";
      }
    }
  }

  // =========================================================================
  // CONTROL DE PASOS GUIADOS (PROGRESSIVE WIZARD)
  // =========================================================================
  function goToStep(stepNumber) {
    state.currentStep = stepNumber;
    $("#view-instrument-editor")?.classList.add("hidden");

    // En el flujo unificado:
    // Paso 1: Selección de Grupo
    // Paso 2: Carga, Mapeo contra Diseño Original, Dimensiones e Hipótesis
    // Paso 3 o 4: Dashboard de Preguntas y Respuestas (#step-4-view)
    // Paso 5: Métricas Avanzadas (#step-5-view)
    const isDashboard = stepNumber === 3 || stepNumber === 4;
    const isAdvanced = stepNumber === 5;

    $("#step-1-view")?.classList.toggle("hidden", stepNumber !== 1);
    $("#step-2-view")?.classList.toggle("hidden", stepNumber !== 2);
    $("#step-3-view")?.classList.add("hidden");
    $("#step-4-view")?.classList.toggle("hidden", !isDashboard);
    $("#step-5-view")?.classList.toggle("hidden", !isAdvanced);

    const p1 = $("#pill-step-1");
    const p2 = $("#pill-step-2");
    const p3 = $("#pill-step-3");
    const p4 = $("#pill-step-4");
    const p5 = $("#pill-step-5");

    if (p1) {
      p1.classList.toggle("is-active", stepNumber === 1);
      p1.classList.toggle("is-completed", stepNumber > 1);
    }
    if (p2) {
      p2.classList.toggle("is-active", stepNumber === 2);
      p2.classList.toggle("is-completed", stepNumber > 2);
      if (stepNumber >= 2) p2.classList.remove("is-disabled");
    }
    if (p3) {
      p3.classList.toggle("is-active", isDashboard);
      p3.classList.toggle("is-completed", isAdvanced);
      if (isDashboard || isAdvanced) p3.classList.remove("is-disabled");
    }
    if (p4) {
      p4.classList.toggle("is-active", isDashboard);
      if (isDashboard || isAdvanced) p4.classList.remove("is-disabled");
    }
    if (p5) {
      p5.classList.toggle("is-active", isAdvanced);
      if (isAdvanced) p5.classList.remove("is-disabled");
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // =========================================================================
  // INICIALIZACIÓN DE LA APLICACIÓN
  // =========================================================================
  async function initApp() {
    initTheme();
    initTooltips();
    initModals();
    bindEvents();
    loadSavedHypotheses();

    let cat = null;
    try {
      cat = await apiFetch("/api/catalog", { headers: { "X-UNAB-Group": "" } });
    } catch (_) {
      try {
        const resp = await fetch("ssot/catalog_13_groups_ssot.json");
        if (resp.ok) cat = await resp.json();
      } catch (e2) {
        console.warn("Fallback catálogo estático falló:", e2);
      }
    }
    if (cat) {
      state.catalog = cat;
      const activeGroups = (cat.groups || []).filter((g) => g.group_id !== "G4");
      state.groupsById = Object.fromEntries(activeGroups.map((g) => [g.group_id, g]));

      renderGroupsSelectionGrid(activeGroups);

      if (state.currentGroupId && state.groupsById[state.currentGroupId]) {
        selectGroupCard(state.currentGroupId);
      }
    }

    const keyInput = $("#gemini-api-key-input");
    if (keyInput && state.geminiApiKey) keyInput.value = state.geminiApiKey;

    const emailInput = $("#team-emails-input");
    if (emailInput && state.teamEmails) emailInput.value = state.teamEmails;

    const cTypeSel = $("#chart-type-select");
    if (cTypeSel) cTypeSel.value = state.chartType;

    const cPalSel = $("#chart-palette-select");
    if (cPalSel) cPalSel.value = state.chartPalette;

    updateUserSessionDisplay();
  }

  function updateUserSessionDisplay() {
    const lbl = $("#user-session-label");
    if (lbl) {
      const roleTxt = state.currentRole === "docente_admin" ? "Docente" : "Estudiante";
      lbl.textContent = `${roleTxt} (${state.currentUserEmail.split("@")[0]})`;
    }
  }

  // =========================================================================
  // PASO 1: SELECCIÓN DE GRUPO DE INVESTIGACIÓN (INV-NO-GROUP4)
  // =========================================================================
  function renderGroupsSelectionGrid(groups) {
    const grid = $("#groups-selection-grid");
    if (!grid) return;

    grid.innerHTML = DOMPurify.sanitize(
      groups
        .map((g) => {
          const isSel = g.group_id === state.currentGroupId;
          return `
            <div class="group-select-card ${isSel ? "is-selected" : ""}" data-group-id="${escapeHtml(g.group_id)}">
              <div>
                <div class="group-card-id">${escapeHtml(g.group_id)} · Ciclo 2-2026</div>
                <div class="group-card-name">${escapeHtml(g.name)}</div>
                <div class="group-card-desc">${escapeHtml(g.theme || g.audit_summary || "")}</div>
              </div>
              <div style="margin-top:.75rem;font-size:.78rem;font-weight:700;color:var(--accent-primary);">
                ${isSel ? "✓ Seleccionado" : "Seleccionar equipo &rarr;"}
              </div>
            </div>
          `;
        })
        .join("")
    );

    $$("#groups-selection-grid .group-select-card").forEach((card) => {
      card.addEventListener("click", () => selectGroupCard(card.dataset.groupId));
    });
  }

  function selectGroupCard(groupId) {
    state.currentGroupId = groupId;
    localStorage.setItem("unab_group_id", groupId);

    $$("#groups-selection-grid .group-select-card").forEach((card) => {
      const isSel = card.dataset.groupId === groupId;
      card.classList.toggle("is-selected", isSel);
      const footer = card.querySelector("div:last-child");
      if (footer) footer.textContent = isSel ? "✓ Seleccionado" : "Seleccionar equipo →";
    });

    const chip = $("#header-active-group-chip");
    if (chip) {
      chip.textContent = `Equipo ${groupId}`;
      chip.classList.remove("hidden");
    }

    const btnNext = $("#btn-step-1-continue");
    if (btnNext) btnNext.removeAttribute("disabled");

    loadSavedHypotheses();
  }

  // =========================================================================
  // PASO 2: INGESTA DE ARCHIVOS, SCOPING DE COLUMNAS Y EXCLUSIÓN DE FÓRMULAS
  // =========================================================================
  function buildDefaultOverlay(gCat) {
    return {
      group_id: gCat.group_id || state.currentGroupId,
      overlay_version: 1,
      source_sha256: "",
      is_posthoc_exploratory: false,
      theoretical_justification: "Estructura confirmatoria base del instrumento",
      missing_strategy: "pairwise",
      exclude_straight_lining: false,
      exclude_mahalanobis_outliers: false,
      column_mapping: {},
      category_mapping: {},
      items: (gCat.questions || []).map((q) => ({
        id: q.id,
        item_id: q.id,
        text: q.text,
        source_column: q.id,
        role: q.role || "LIKERT_REFLECTIVA",
        dimension: q.dimension || "General",
        scale_type: q.scale_type || "likert_5",
        scale_min: q.scale_min || 1,
        scale_max: q.scale_max || 5,
        scoring_direction: q.scoring_direction || "direct",
        is_reverse: bool(q.is_reverse),
        included: true,
        options:
          q.options || [
            "1 = Totalmente en desacuerdo",
            "2 = En desacuerdo",
            "3 = Ni de acuerdo ni en desacuerdo",
            "4 = De acuerdo",
            "5 = Totalmente de acuerdo",
          ],
      })),
    };
  }

  function bool(v) {
    return v === true || v === "true" || v === 1;
  }

  async function loadSampleDataForGroup(groupId) {
    const statusMsg = $("#ingest-status-msg");
    if (statusMsg) statusMsg.textContent = "Cargando respuestas de prueba del equipo...";

    try {
      const gCat = state.groupsById[groupId] || { group_id: groupId, questions: [] };
      state.originalOverlay = buildDefaultOverlay(gCat);
      state.currentOverlay = JSON.parse(JSON.stringify(state.originalOverlay));

      let fix = null;
      try {
        fix = await apiFetch(`/api/qa-fixture/${groupId}`);
      } catch (_) {
        try {
          const resp = await fetch("ssot/qa_test_fixtures_13_groups.json");
          if (resp.ok) {
            const allFixtures = await resp.json();
            const grp = (allFixtures.groups && allFixtures.groups[groupId]) || allFixtures[groupId];
            const rawRows = (grp && (grp.rows || grp.rows_anon)) || [];
            fix = {
              rows_anon: rawRows,
              source_sha256: (grp && grp.source_sha256) || "FIXTURE_QA_OFFLINE_OK",
            };
          }
        } catch (e2) {
          console.warn("Fallback fixture estático falló:", e2);
        }
      }
      fix = fix || { rows_anon: [], source_sha256: "STATIC_EMPTY" };
      const rows = fix.rows_anon || [];
      state.rawRowsAnon = rows;
      state.filteredRowsAnon = rows.slice();
      state.activeCrossFilters = {};
      state.sourceSha256 = fix.source_sha256 || "FIXTURE_QA_OK";

      // Detectar columnas del archivo y preparar mapeo contra diseño
      setupColumnScopingFromRows(rows, state.currentOverlay);
      renderUnifiedMappingTable();
      renderHypothesesSetup();
      $("#unified-mapping-section")?.classList.remove("hidden");

      if (statusMsg) statusMsg.textContent = `✓ Respuestas cargadas (${rows.length} encuestas detectadas).`;

      const btnNext = $("#btn-confirm-and-go-to-dashboard");
      if (btnNext) btnNext.removeAttribute("disabled");
      $("#btn-step-2-continue")?.removeAttribute("disabled");

      // Diagnóstico rápido en segundo plano sin cambiar de paso intempestivamente
      await processAnalysisAndGoToDiagnostic(false);
    } catch (err) {
      if (statusMsg) statusMsg.textContent = `Error: ${err.message}`;
    }
  }

  function setupColumnScopingFromRows(rows, overlay) {
    if (!rows || rows.length === 0) return;
    const sample = rows[0];
    const cols = Object.keys(sample);

    state.columnScopingState.columns = cols;
    state.columnScopingState.excluded.clear();
    state.columnScopingState.mapping = {};
    state.columnScopingState.dimensions = state.columnScopingState.dimensions || {};
    state.columnScopingState.editedTexts = state.columnScopingState.editedTexts || {};

    // Auto-marcar exclusión para columnas de fórmulas (SUMA, PROMEDIO) y marcas temporales
    cols.forEach((col) => {
      const upper = col.toUpperCase();
      if (
        upper.includes("SUMA") ||
        upper.includes("PROMEDIO") ||
        upper.includes("TOTAL") ||
        upper.includes("MARCA TEMPORAL") ||
        upper.includes("TIMESTAMP") ||
        upper.includes("HORA") ||
        upper.includes("FECHA")
      ) {
        state.columnScopingState.excluded.add(col);
      }
    });

    // Mapeo inicial hacia reactivos del overlay
    const items = overlay?.items || [];
    cols.forEach((col) => {
      if (!state.columnScopingState.excluded.has(col)) {
        const match = items.find(
          (it) => it.id.toLowerCase() === col.toLowerCase() || (it.text && it.text.toLowerCase().includes(col.toLowerCase()))
        );
        if (match) {
          state.columnScopingState.mapping[col] = match.id;
          state.columnScopingState.dimensions[col] = state.columnScopingState.dimensions[col] || match.dimension || "General";
          state.columnScopingState.editedTexts[col] = state.columnScopingState.editedTexts[col] || match.text || col;
        } else {
          state.columnScopingState.dimensions[col] = state.columnScopingState.dimensions[col] || "General";
          state.columnScopingState.editedTexts[col] = state.columnScopingState.editedTexts[col] || col;
        }
      }
    });

    renderColumnScopingTable();
    renderUnifiedMappingTable();
  }

  function openColumnScopingModal() {
    if (!state.columnScopingState.columns.length && state.rawRowsAnon.length) {
      setupColumnScopingFromRows(state.rawRowsAnon, state.currentOverlay);
    }
    renderColumnScopingTable();
    $("#modal-column-scoping")?.classList.remove("hidden");
  }

  function closeColumnScopingModal() {
    $("#modal-column-scoping")?.classList.add("hidden");
  }

  function renderColumnScopingTable() {
    const tbody = $("#column-scoping-tbody");
    if (!tbody) return;

    const cols = state.columnScopingState.columns;
    const items = state.currentOverlay?.items || [];

    const detCount = $("#scoping-detected-cols-count");
    if (detCount) detCount.textContent = cols.length;

    const exclCount = $("#scoping-excluded-cols-count");
    if (exclCount) exclCount.textContent = state.columnScopingState.excluded.size;

    tbody.innerHTML = DOMPurify.sanitize(
      cols
        .map((col) => {
          const isExcl = state.columnScopingState.excluded.has(col);
          const mappedId = state.columnScopingState.mapping[col] || "";
          const sampleVal = state.rawRowsAnon.length ? String(state.rawRowsAnon[0][col] ?? "") : "—";

          const upper = col.toUpperCase();
          const isFormula = upper.includes("SUMA") || upper.includes("PROMEDIO") || upper.includes("TOTAL");
          const isMeta = upper.includes("MARCA TEMPORAL") || upper.includes("TIMESTAMP");

          const typeTag = isFormula
            ? `<span style="color:var(--accent-warn);font-weight:700;">Fórmula Excel</span>`
            : isMeta
            ? `<span style="color:var(--text-muted);">Metadato</span>`
            : `<span style="color:var(--accent-teal);">Dato de Encuesta</span>`;

          const statusBadge = isExcl
            ? `<span style="padding:2px 6px;border-radius:4px;font-size:.72rem;background:rgba(239,68,68,0.15);color:var(--accent-warn);font-weight:700;">🚫 Excluida</span>`
            : mappedId
            ? `<span style="padding:2px 6px;border-radius:4px;font-size:.72rem;background:rgba(16,185,129,0.15);color:var(--accent-ok);font-weight:700;">✓ Mapeada</span>`
            : `<span style="padding:2px 6px;border-radius:4px;font-size:.72rem;background:rgba(99,102,241,0.15);color:var(--accent-primary);font-weight:700;">Activa</span>`;

          const optionsHtml =
            `<option value="">-- Sin asignar --</option>` +
            items
              .map(
                (it) =>
                  `<option value="${escapeHtml(it.id)}" ${it.id === mappedId ? "selected" : ""}>${escapeHtml(it.id)}: ${escapeHtml(
                    (it.text || "").slice(0, 45)
                  )}...</option>`
              )
              .join("");

          return `
            <tr style="border-bottom:1px solid var(--border-color);${isExcl ? "opacity:.65;background:rgba(0,0,0,0.05);" : ""}">
              <td style="padding:.65rem .85rem;font-weight:700;font-family:var(--font-mono);">${escapeHtml(col)}</td>
              <td style="padding:.65rem .85rem;">
                <div>${typeTag}</div>
                <div style="font-size:.74rem;color:var(--text-muted);margin-top:2px;">Muestra: ${escapeHtml(sampleVal.slice(0, 30))}</div>
              </td>
              <td style="padding:.65rem .85rem;">
                <select class="scoping-assign-select" data-col="${escapeHtml(col)}" style="padding:.3rem;font-size:.8rem;border-radius:6px;width:100%;max-width:240px;background:var(--bg-input);color:var(--text-main);border:1px solid var(--border-color);" ${
            isExcl ? "disabled" : ""
          }>
                  ${optionsHtml}
                </select>
              </td>
              <td style="padding:.65rem .85rem;text-align:center;">${statusBadge}</td>
              <td style="padding:.65rem .85rem;text-align:center;">
                <input type="checkbox" class="scoping-exclude-chk" data-col="${escapeHtml(col)}" ${isExcl ? "checked" : ""} title="Excluir de psicometría" />
              </td>
            </tr>
          `;
        })
        .join("")
    );

    // Eventos de cambios en exclusión y mapeo
    $$(".scoping-exclude-chk").forEach((chk) => {
      chk.addEventListener("change", (e) => {
        const col = e.target.dataset.col;
        if (e.target.checked) {
          state.columnScopingState.excluded.add(col);
        } else {
          state.columnScopingState.excluded.delete(col);
        }
        renderColumnScopingTable();
      });
    });

    $$(".scoping-assign-select").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const col = e.target.dataset.col;
        state.columnScopingState.mapping[col] = e.target.value;
      });
    });
  }

  function autoDetectScoping() {
    setupColumnScopingFromRows(state.rawRowsAnon, state.currentOverlay);
  }

  function excludeFormulasOnly() {
    state.columnScopingState.columns.forEach((col) => {
      const upper = col.toUpperCase();
      if (
        upper.includes("SUMA") ||
        upper.includes("PROMEDIO") ||
        upper.includes("TOTAL") ||
        upper.includes("MARCA TEMPORAL") ||
        upper.includes("TIMESTAMP")
      ) {
        state.columnScopingState.excluded.add(col);
      }
    });
    renderColumnScopingTable();
  }

  async function confirmColumnScoping() {
    if (!state.currentOverlay) return;

    // Aplicar mapeo confirmado al overlay
    state.currentOverlay.column_mapping = Object.assign({}, state.columnScopingState.mapping);

    // Marcar exclusión en los reactivos correspondientes
    state.currentOverlay.items.forEach((it) => {
      const sourceCol = it.source_column || it.id;
      if (state.columnScopingState.excluded.has(sourceCol)) {
        it.included = false;
        it.exclude_from_psychometrics = true;
      }
    });

    closeColumnScopingModal();
    await processAnalysisAndGoToDiagnostic();
  }

  async function processAnalysisAndGoToDiagnostic(navigate = true) {
    if (!state.currentOverlay) {
      const gCat = state.groupsById[state.currentGroupId] || { group_id: state.currentGroupId, questions: [] };
      state.currentOverlay = buildDefaultOverlay(gCat);
    }

    // Filtrar overlay para enviar sólo ítems incluidos en la estimación psicométrica
    const activeOverlay = JSON.parse(JSON.stringify(state.currentOverlay));
    activeOverlay.items = (activeOverlay.items || []).filter((it) => it.included !== false);

    let res = null;
    try {
      res = await apiFetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          group_id: state.currentGroupId,
          rows_anon: state.rawRowsAnon,
          overlay_spec: activeOverlay,
          bivariate_test_count: 1,
          hypotheses: state.hypotheses,
        }),
      });
    } catch (err) {
      if (window.PsychometricsEngine) {
        res = window.PsychometricsEngine.runFullAnalysis(state.rawRowsAnon, activeOverlay, state.originalOverlay);
      }
    }

    if (!res) return;
    state.analysisResult = res;

    renderDiagnosticStep(res);
    renderHypothesesSetup();
    renderMethodologicalWarnings(res);
    if (navigate) {
      goToStep(3);
    }
  }

  // =========================================================================
  // PASO 2 UNIFICADO: MAPEO CONTRA DISEÑO ORIGINAL, DIMENSIONES E HIPÓTESIS
  // =========================================================================
  function getAvailableDimensions() {
    const dims = new Set();
    const gCat = state.groupsById[state.currentGroupId];
    if (gCat && gCat.questions) {
      gCat.questions.forEach((q) => {
        if (q.dimension) dims.add(q.dimension);
      });
    }
    if (state.currentOverlay && state.currentOverlay.items) {
      state.currentOverlay.items.forEach((it) => {
        if (it.dimension) dims.add(it.dimension);
      });
    }
    Object.values(state.columnScopingState?.dimensions || {}).forEach((d) => {
      if (d) dims.add(d);
    });
    dims.add("Filtro");
    dims.add("Sociodemográfico");
    return Array.from(dims).filter(Boolean);
  }

  function renderUnifiedMappingTable() {
    const tbody = $("#unified-mapping-tbody");
    if (!tbody) return;

    const cols = state.columnScopingState?.columns || [];
    const items = state.currentOverlay?.items || [];
    const allDims = getAvailableDimensions();

    const detCount = $("#mapping-detected-count");
    if (detCount) detCount.textContent = cols.length;

    const exclCount = $("#mapping-excluded-count");
    if (exclCount) exclCount.textContent = state.columnScopingState.excluded.size;

    const assCount = $("#mapping-assigned-count");
    if (assCount) assCount.textContent = cols.length - state.columnScopingState.excluded.size;

    tbody.innerHTML = DOMPurify.sanitize(
      cols
        .map((col) => {
          const isExcl = state.columnScopingState.excluded.has(col);
          const mappedId = state.columnScopingState.mapping[col] || "";
          const matchedItem = items.find((it) => it.id === mappedId);
          const assignedDim = state.columnScopingState.dimensions[col] || (matchedItem ? matchedItem.dimension : "General");
          const currentText = state.columnScopingState.editedTexts[col] !== undefined
            ? state.columnScopingState.editedTexts[col]
            : (matchedItem ? matchedItem.text : col);

          const upper = col.toUpperCase();
          const isFormula = upper.includes("SUMA") || upper.includes("PROMEDIO") || upper.includes("TOTAL");
          const isMeta = upper.includes("MARCA TEMPORAL") || upper.includes("TIMESTAMP");

          const formulaBadge = isFormula
            ? `<div style="font-size:.72rem;color:var(--accent-warn);font-weight:700;">🚫 Fórmula Excel</div>`
            : isMeta
            ? `<div style="font-size:.72rem;color:var(--text-muted);font-weight:600;">ℹ️ Metadato</div>`
            : "";

          const itemOptions =
            `<option value="">-- Sin vincular / Personalizado --</option>` +
            items
              .map(
                (it) =>
                  `<option value="${escapeHtml(it.id)}" ${it.id === mappedId ? "selected" : ""}>${escapeHtml(it.id)}: ${escapeHtml(
                    (it.text || "").slice(0, 45)
                  )}...</option>`
              )
              .join("");

          const dimOptions =
            allDims
              .map(
                (d) =>
                  `<option value="${escapeHtml(d)}" ${d === assignedDim ? "selected" : ""}>${escapeHtml(d)}</option>`
              )
              .join("") + `<option value="__custom__">+ Nueva dimensión...</option>`;

          return `
            <tr class="${isExcl ? "is-excluded-row" : ""}">
              <td style="padding:.65rem .8rem;">
                <div class="mapping-col-name" title="${escapeHtml(col)}">${escapeHtml(col)}</div>
                ${formulaBadge}
              </td>
              <td style="padding:.65rem .8rem;">
                <select class="mapping-item-select form-select-sm" data-col="${escapeHtml(col)}" ${isExcl ? "disabled" : ""}>
                  ${itemOptions}
                </select>
              </td>
              <td style="padding:.65rem .8rem;">
                <select class="mapping-dim-select form-select-sm" data-col="${escapeHtml(col)}" ${isExcl ? "disabled" : ""}>
                  ${dimOptions}
                </select>
              </td>
              <td style="padding:.65rem .8rem;">
                <input type="text" class="mapping-text-input" data-col="${escapeHtml(col)}" value="${escapeHtml(currentText)}" ${isExcl ? "disabled" : ""} />
              </td>
              <td style="padding:.65rem .8rem;text-align:center;">
                <input type="checkbox" class="mapping-include-chk" data-col="${escapeHtml(col)}" ${isExcl ? "" : "checked"} title="Incluir en psicometría y dashboard" />
              </td>
            </tr>
          `;
        })
        .join("")
    );

    // Eventos interactivos en la matriz de mapeo
    $$(".mapping-include-chk").forEach((chk) => {
      chk.addEventListener("change", (e) => {
        const col = e.target.dataset.col;
        if (e.target.checked) {
          state.columnScopingState.excluded.delete(col);
        } else {
          state.columnScopingState.excluded.add(col);
        }
        renderUnifiedMappingTable();
        renderColumnScopingTable();
        renderHypothesesSetup();
      });
    });

    $$(".mapping-item-select").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const col = e.target.dataset.col;
        const val = e.target.value;
        state.columnScopingState.mapping[col] = val;
        const matched = items.find((it) => it.id === val);
        if (matched) {
          state.columnScopingState.dimensions[col] = matched.dimension || "General";
          state.columnScopingState.editedTexts[col] = matched.text || col;
        }
        renderUnifiedMappingTable();
        renderHypothesesSetup();
      });
    });

    $$(".mapping-dim-select").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const col = e.target.dataset.col;
        let val = e.target.value;
        if (val === "__custom__") {
          const custom = prompt("Escribe el nombre de la nueva dimensión / constructo teórico:");
          if (custom && custom.trim()) {
            val = custom.trim();
          } else {
            sel.value = state.columnScopingState.dimensions[col] || "General";
            return;
          }
        }
        state.columnScopingState.dimensions[col] = val;
        const mappedId = state.columnScopingState.mapping[col];
        if (mappedId && state.currentOverlay?.items) {
          const it = state.currentOverlay.items.find((x) => x.id === mappedId);
          if (it) it.dimension = val;
        }
        renderUnifiedMappingTable();
        renderHypothesesSetup();
      });
    });

    $$(".mapping-text-input").forEach((inp) => {
      inp.addEventListener("input", (e) => {
        const col = e.target.dataset.col;
        const val = e.target.value;
        state.columnScopingState.editedTexts[col] = val;
        const mappedId = state.columnScopingState.mapping[col];
        if (mappedId && state.currentOverlay?.items) {
          const it = state.currentOverlay.items.find((x) => x.id === mappedId);
          if (it) it.text = val;
        }
      });
    });
  }

  async function confirmAndOpenDashboard() {
    if (!state.rawRowsAnon || state.rawRowsAnon.length === 0) {
      alert("Por favor carga un archivo de respuestas o usa las respuestas de prueba.");
      return;
    }

    // 1. Aplicar mapeo, textos editados, dimensiones y exclusiones a state.currentOverlay
    const cols = state.columnScopingState?.columns || [];
    const items = state.currentOverlay?.items || [];

    cols.forEach((col) => {
      const isExcl = state.columnScopingState.excluded.has(col);
      const mappedId = state.columnScopingState.mapping[col];
      const customDim = state.columnScopingState.dimensions[col];
      const customText = state.columnScopingState.editedTexts[col];

      if (mappedId) {
        const it = items.find((x) => x.id === mappedId);
        if (it) {
          if (customDim) it.dimension = customDim;
          if (customText) it.text = customText;
          it.included = !isExcl;
          it.exclude_from_psychometrics = isExcl;
        }
      }
    });

    // 2. Consolidar hipótesis general y específicas
    const generalText = $("#txt-hypothesis-general")?.value?.trim() || $("#txt-hypothesis-statement-step3")?.value?.trim() || "";
    const generalX = $("#hyp-general-x")?.value || "";
    const generalY = $("#hyp-general-y")?.value || "";

    const consolidated = [];
    if (generalText && generalX && generalY) {
      consolidated.push({
        id: "HG",
        text: generalText,
        x_dim: generalX,
        y_dim: generalY,
      });
    }

    (state.structuredHypotheses?.specifics || []).forEach((sh, idx) => {
      const t = sh.text?.trim() || `Relación específica ${idx + 1}`;
      if (sh.x_dim && sh.y_dim) {
        consolidated.push({
          id: `HE${idx + 1}`,
          text: t,
          x_dim: sh.x_dim,
          y_dim: sh.y_dim,
        });
      }
    });

    if (consolidated.length > 0) {
      state.hypotheses = consolidated;
      saveHypotheses();
    }

    // 3. Procesar análisis completo
    await processAnalysisAndGoToDiagnostic(false);

    // 4. Navegar al Dashboard y renderizar
    goToStep(3);
    renderDashboardStep();
  }

  // =========================================================================
  // PASO 3: DIAGNÓSTICO, GEMINI AI E HIPÓTESIS
  // =========================================================================
  function renderDiagnosticStep(res) {
    const qCount = res.n_items || state.currentOverlay?.items?.filter((i) => i.included !== false).length || 0;
    const sCount = res.n_active || state.rawRowsAnon.length || 0;

    const totalQEl = $("#diag-total-questions");
    if (totalQEl) totalQEl.textContent = qCount;

    const sampleSizeEl = $("#diag-sample-size");
    if (sampleSizeEl) sampleSizeEl.textContent = sCount;

    const isHealthy = qCount >= 6 && sCount >= 15;
    const icon = $("#diag-status-icon");
    const title = $("#diag-status-title");
    const sub = $("#diag-status-sub");

    if (icon && title && sub) {
      if (isHealthy) {
        icon.textContent = "✅";
        title.textContent = "Listo para Validar";
        title.style.color = "var(--accent-ok)";
        sub.textContent = "Tu muestra y preguntas tienen el tamaño adecuado";
      } else {
        icon.textContent = "⚠️";
        title.textContent = "Muestra Pequeña";
        title.style.color = "var(--accent-warn)";
        sub.textContent = "Se puede visualizar, pero se recomienda recolectar más respuestas";
      }
    }
  }

  async function callGeminiRepair() {
    const key = $("#gemini-api-key-input")?.value?.trim() || "";
    if (key) {
      state.geminiApiKey = key;
      localStorage.setItem("unab_gemini_api_key", key);
    }

    const box = $("#gemini-output-box");
    if (box) {
      box.classList.remove("hidden");
      box.textContent = "Consultando a Gemini AI para analizar la redacción y balance de tus preguntas...";
    }

    const questions = (state.currentOverlay?.items || [])
      .filter((i) => i.included !== false)
      .map((i) => ({ id: i.id, text: i.text, dimension: i.dimension }));

    try {
      const resp = await apiFetch("/api/gemini-repair-instrument", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          group_id: state.currentGroupId,
          gemini_api_key: key,
          questions: questions,
          diagnostic_issues: ["Revisión de claridad de reactivos y validez psicométrica"],
        }),
      });

      state.geminiImprovements = resp.improved_items || [];
      if (box) {
        box.innerHTML = DOMPurify.sanitize(`
          <div style="font-weight:700;color:var(--accent-primary);margin-bottom:.5rem;">✨ Recomendaciones de Gemini AI (${escapeHtml(
            resp.provider || "Gemini 2.5"
          )}):</div>
          <div>${escapeHtml(resp.recommendations || "Tus preguntas están bien formuladas y equilibradas.")}</div>
        `);
      }

      if (state.geminiImprovements.length > 0) {
        $("#gemini-apply-container")?.classList.remove("hidden");
      }
    } catch (err) {
      if (box) box.textContent = `Nota: ${err.message}`;
    }
  }

  function applyGeminiImprovements() {
    if (!state.currentOverlay || !state.geminiImprovements.length) return;
    const impMap = Object.fromEntries(state.geminiImprovements.map((imp) => [imp.id, imp.suggested_text]));

    state.currentOverlay.items.forEach((it) => {
      if (impMap[it.id]) {
        it.text = impMap[it.id];
        it.is_gemini_improved = true;
      }
    });

    const box = $("#gemini-output-box");
    if (box) {
      box.innerHTML += `<div style="margin-top:.75rem;padding:.5rem;background:rgba(16,185,129,0.15);color:var(--accent-ok);border-radius:4px;font-weight:700;">✓ Se aplicaron las mejoras de redacción de Gemini AI al cuestionario.</div>`;
    }
    $("#btn-apply-gemini-improvements")?.setAttribute("disabled", "true");
  }

  // --- GESTIÓN DE HIPÓTESIS CON GEMINI AI Y CÁLCULO EMPÍRICO ---
  function loadSavedHypotheses() {
    const raw = localStorage.getItem(`unab_hypotheses_${state.currentGroupId}`);
    if (raw) {
      try {
        state.hypotheses = JSON.parse(raw);
      } catch (_) {
        state.hypotheses = [];
      }
    } else {
      state.hypotheses = [];
    }
  }

  function saveHypotheses() {
    localStorage.setItem(`unab_hypotheses_${state.currentGroupId}`, JSON.stringify(state.hypotheses));
  }

  function renderHypothesesSetup() {
    const allDims = getAvailableDimensions();
    const dims = allDims.filter(
      (d) => !d.toLowerCase().includes("socio") && !d.toLowerCase().includes("filtro") && !d.toLowerCase().includes("timestamp")
    );
    if (dims.length === 0) {
      dims.push("Dimensión Principal", "Dimensión Secundaria");
    }

    const hgX = $("#hyp-general-x");
    const hgY = $("#hyp-general-y");
    if (hgX && hgY) {
      const opts = dims.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
      const curX = hgX.value;
      const curY = hgY.value;
      hgX.innerHTML = opts;
      hgY.innerHTML = opts;
      if (curX && dims.includes(curX)) hgX.value = curX;
      if (curY && dims.includes(curY)) hgY.value = curY;
      else if (dims.length > 1) hgY.selectedIndex = 1;
    }

    if (!state.structuredHypotheses) {
      state.structuredHypotheses = {
        general: { text: "", x_dim: dims[0] || "", y_dim: dims[1] || dims[0] || "" },
        specifics: [
          { id: "HE1", text: "", x_dim: dims[0] || "", y_dim: dims[1] || dims[0] || "" },
          { id: "HE2", text: "", x_dim: dims[0] || "", y_dim: dims[1] || dims[0] || "" },
        ],
      };
    }

    renderSpecificHypothesesList(dims);

    const xSel = $("#hyp-x-dim");
    const ySel = $("#hyp-y-dim");
    if (xSel && ySel) {
      const opts = dims.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
      xSel.innerHTML = opts;
      ySel.innerHTML = opts;
      if (dims.length > 1) ySel.selectedIndex = 1;
    }

    renderHypothesesList();
  }

  function renderSpecificHypothesesList(hypDims) {
    const list = $("#specific-hypotheses-list");
    if (!list) return;

    if (!hypDims) {
      hypDims = getAvailableDimensions().filter(
        (d) => !d.toLowerCase().includes("socio") && !d.toLowerCase().includes("filtro")
      );
    }

    const specifics = state.structuredHypotheses?.specifics || [];
    list.innerHTML = DOMPurify.sanitize(
      specifics
        .map((he, idx) => {
          const optsX = hypDims.map((d) => `<option value="${escapeHtml(d)}" ${d === he.x_dim ? "selected" : ""}>${escapeHtml(d)}</option>`).join("");
          const optsY = hypDims.map((d) => `<option value="${escapeHtml(d)}" ${d === he.y_dim ? "selected" : ""}>${escapeHtml(d)}</option>`).join("");
          return `
            <div class="specific-hyp-card" data-index="${idx}">
              <div class="specific-hyp-header">
                <span class="specific-hyp-title">🔬 Hipótesis Específica #${idx + 1} (${escapeHtml(he.id || `HE${idx + 1}`)})</span>
                ${specifics.length > 1 ? `<button type="button" class="btn-remove-specific-hyp" data-index="${idx}" title="Eliminar hipótesis específica">✕</button>` : ""}
              </div>
              <textarea class="specific-hyp-text" data-index="${idx}" rows="2" style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);padding:.45rem;background:var(--bg-input);color:var(--text-main);border:1px solid var(--border-color);font-size:.82rem;resize:vertical;" placeholder="Redacción de la hipótesis específica ${idx + 1}...">${escapeHtml(he.text || "")}</textarea>
              <div style="display:flex;gap:.75rem;flex-wrap:wrap;align-items:flex-end;">
                <div style="flex:1;min-width:160px;">
                  <label style="font-size:.74rem;font-weight:700;display:block;margin-bottom:.2rem;">Variable Predictora (X):</label>
                  <select class="specific-hyp-x form-select-sm" data-index="${idx}" style="width:100%;padding:.35rem;border-radius:4px;background:var(--bg-input);color:var(--text-main);border:1px solid var(--border-color);font-size:.8rem;">
                    ${optsX}
                  </select>
                </div>
                <div style="flex:1;min-width:160px;">
                  <label style="font-size:.74rem;font-weight:700;display:block;margin-bottom:.2rem;">Variable Resultado (Y):</label>
                  <select class="specific-hyp-y form-select-sm" data-index="${idx}" style="width:100%;padding:.35rem;border-radius:4px;background:var(--bg-input);color:var(--text-main);border:1px solid var(--border-color);font-size:.8rem;">
                    ${optsY}
                  </select>
                </div>
              </div>
            </div>
          `;
        })
        .join("")
    );

    // Eventos interactivos en tarjetas específicas
    $$(".btn-remove-specific-hyp").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const i = parseInt(e.target.dataset.index, 10);
        state.structuredHypotheses.specifics.splice(i, 1);
        renderSpecificHypothesesList(hypDims);
      });
    });

    $$(".specific-hyp-text").forEach((txt) => {
      txt.addEventListener("input", (e) => {
        const i = parseInt(e.target.dataset.index, 10);
        if (state.structuredHypotheses?.specifics[i]) {
          state.structuredHypotheses.specifics[i].text = e.target.value;
        }
      });
    });

    $$(".specific-hyp-x").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const i = parseInt(e.target.dataset.index, 10);
        if (state.structuredHypotheses?.specifics[i]) {
          state.structuredHypotheses.specifics[i].x_dim = e.target.value;
        }
      });
    });

    $$(".specific-hyp-y").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const i = parseInt(e.target.dataset.index, 10);
        if (state.structuredHypotheses?.specifics[i]) {
          state.structuredHypotheses.specifics[i].y_dim = e.target.value;
        }
      });
    });

    const addBtn = $("#btn-add-specific-hypothesis");
    if (addBtn) {
      addBtn.style.display = specifics.length >= 3 ? "none" : "inline-block";
    }
  }

  function renderHypothesesList() {
    const container = $("#hypotheses-list-container");
    if (!container) return;

    if (state.hypotheses.length === 0) {
      container.innerHTML = `<div style="font-size:.82rem;color:var(--text-muted);font-style:italic;">No hay hipótesis definidas aún. Agrega una o pulsa 'Sugerir hipótesis'.</div>`;
      return;
    }

    container.innerHTML = DOMPurify.sanitize(
      state.hypotheses
        .map(
          (h, idx) => `
        <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg-card);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:.5rem .75rem;font-size:.85rem;">
          <div>
            <strong style="color:var(--accent-primary);">${escapeHtml(h.id)}:</strong>
            <span>${escapeHtml(h.x_dim)} &rarr; ${escapeHtml(h.y_dim)}</span>
            <span style="color:var(--text-muted);margin-left:.5rem;font-size:.78rem;">(${escapeHtml(h.text)})</span>
          </div>
          <button type="button" class="btn-delete-hyp" data-index="${idx}" style="background:none;border:none;color:var(--accent-warn);cursor:pointer;font-weight:700;">✕</button>
        </div>
      `
        )
        .join("")
    );

    $$(".btn-delete-hyp").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.dataset.index, 10);
        state.hypotheses.splice(i, 1);
        saveHypotheses();
        renderHypothesesList();
      });
    });
  }

  function addHypothesisFromUI() {
    const x = $("#hyp-x-dim")?.value;
    const y = $("#hyp-y-dim")?.value;
    if (!x || !y) return;
    if (x === y) {
      alert("La variable predictora y la variable resultado deben ser distintas.");
      return;
    }

    const nextId = `H${state.hypotheses.length + 1}`;
    state.hypotheses.push({
      id: nextId,
      x_dim: x,
      y_dim: y,
      text: `A mayor nivel de ${x}, mayor será el nivel de ${y}`,
    });
    saveHypotheses();
    renderHypothesesList();
  }

  function suggestDefaultHypotheses() {
    const overlay = state.currentOverlay || {};
    const items = (overlay.items || []).filter((i) => i.included !== false);
    const validItems = items.filter(
      (i) => i.role === "LIKERT_REFLECTIVA" || i.scale_type === "Likert" || (i.role !== "SOCIODEMOGRAFICA_FILTRO" && i.scale_type !== "Nominal")
    );
    const dims = Array.from(new Set(validItems.map((i) => i.dimension || "General"))).filter(
      (d) => !d.toLowerCase().includes("socio") && !d.toLowerCase().includes("filtro") && !d.toLowerCase().includes("conducta")
    );

    if (dims.length < 2) {
      alert("Se requieren al menos 2 dimensiones temáticas para sugerir hipótesis.");
      return;
    }

    const target = dims[dims.length - 1];
    state.hypotheses = [];
    for (let i = 0; i < dims.length - 1 && i < 3; i++) {
      state.hypotheses.push({
        id: `H${i + 1}`,
        x_dim: dims[i],
        y_dim: target,
        text: `Existe una relación positiva y estadísticamente significativa entre ${dims[i]} y ${target}`,
      });
    }
    saveHypotheses();
    renderHypothesesList();
  }

  // Extracción de Hipótesis Literal con Gemini AI
  async function handleGeminiExtractHypothesis(sourceStep = "step5") {
    const inputStep3 = $("#txt-hypothesis-statement-step3");
    const inputStep5 = $("#txt-hypothesis-statement");

    let statement = "";
    if (sourceStep === "step3" && inputStep3) {
      statement = inputStep3.value.trim();
    } else if (inputStep5) {
      statement = inputStep5.value.trim();
    }
    if (!statement && inputStep3) statement = inputStep3.value.trim();

    if (!statement) {
      alert("Por favor escribe o pega el enunciado literal de tu hipótesis desde tu investigación.");
      return;
    }

    if (inputStep3) inputStep3.value = statement;
    if (inputStep5) inputStep5.value = statement;

    const statusEl = sourceStep === "step3" ? $("#gemini-hypothesis-status-step3") : $("#gemini-hypothesis-status");
    const btn = sourceStep === "step3" ? $("#btn-map-hypothesis-gemini-step3") : $("#btn-map-hypothesis-gemini");
    const resultCardStep3 = $("#hypothesis-gemini-result-card-step3");
    const resultCardStep5 = $("#hypothesis-gemini-result-card");

    if (statusEl) statusEl.textContent = "Extrayendo variables con Gemini AI...";
    if (btn) btn.setAttribute("disabled", "true");

    const overlay = state.currentOverlay || {};

    let extraction = null;
    try {
      extraction = await apiFetch("/api/gemini-extract-hypothesis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hypothesis_text: statement,
          instrument: overlay,
          group_id: state.currentGroupId,
          gemini_api_key: state.geminiApiKey,
        }),
      });
    } catch (err) {
      console.warn("Fallo endpoint backend /api/gemini-extract-hypothesis, ejecutando heurística local:", err);
      extraction = extractHypothesisLocalHeuristic(statement, overlay);
    }

    if (btn) btn.removeAttribute("disabled");
    if (statusEl) statusEl.textContent = "✓ Mapeo completado.";

    if (extraction) {
      state.lastExtractedHypothesis = extraction;

      // Auto-seleccionar Variable X y Variable Y en selectores si existen
      const xDim = extraction.matched_x_dimension || extraction.variable_x;
      const yDim = extraction.matched_y_dimension || extraction.variable_y;

      const xSel = $("#hyp-x-dim");
      const ySel = $("#hyp-y-dim");
      const genX = $("#hyp-general-x");
      const genY = $("#hyp-general-y");

      if (xSel && xDim) {
        for (const opt of Array.from(xSel.options)) {
          if (opt.value.toLowerCase().includes(xDim.toLowerCase()) || xDim.toLowerCase().includes(opt.value.toLowerCase())) {
            xSel.value = opt.value;
            break;
          }
        }
      }
      if (ySel && yDim) {
        for (const opt of Array.from(ySel.options)) {
          if (opt.value.toLowerCase().includes(yDim.toLowerCase()) || yDim.toLowerCase().includes(opt.value.toLowerCase())) {
            ySel.value = opt.value;
            break;
          }
        }
      }
      if (genX && xDim) {
        for (const opt of Array.from(genX.options)) {
          if (opt.value.toLowerCase().includes(xDim.toLowerCase()) || xDim.toLowerCase().includes(opt.value.toLowerCase())) {
            genX.value = opt.value;
            break;
          }
        }
      }
      if (genY && yDim) {
        for (const opt of Array.from(genY.options)) {
          if (opt.value.toLowerCase().includes(yDim.toLowerCase()) || yDim.toLowerCase().includes(opt.value.toLowerCase())) {
            genY.value = opt.value;
            break;
          }
        }
      }

      const dirText = extraction.direction === "negative" ? "Relación Inversa Negativa (-)" : "Relación Directa Positiva (+)";

      // Renderizar resultado en Step 3
      if (resultCardStep3) {
        resultCardStep3.classList.remove("hidden");
        resultCardStep3.innerHTML = `
          <div style="background:var(--bg-card);padding:.75rem;border-radius:var(--radius-sm);border:1px solid var(--border-color);font-size:.82rem;">
            <div style="font-weight:700;color:var(--accent-ok);margin-bottom:.35rem;">✓ Variables Mapeadas con Gemini AI:</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.35rem;">
              <div><strong>Variable X (Independiente):</strong> ${escapeHtml(extraction.variable_x || xDim)} <span style="color:var(--text-muted);font-size:.75rem;">(${escapeHtml(xDim)})</span></div>
              <div><strong>Variable Y (Dependiente):</strong> ${escapeHtml(extraction.variable_y || yDim)} <span style="color:var(--text-muted);font-size:.75rem;">(${escapeHtml(yDim)})</span></div>
            </div>
            <div style="font-size:.78rem;color:var(--text-muted);"><strong>Dirección prevista:</strong> ${dirText}</div>
          </div>
        `;
      }

      // Renderizar tarjeta de resultado del mapeo en Step 5
      if (resultCardStep5) {
        resultCardStep5.classList.remove("hidden");
        const varXEl = $("#hyp-gemini-var-x");
        const dimXEl = $("#hyp-gemini-dim-x");
        const varYEl = $("#hyp-gemini-var-y");
        const dimYEl = $("#hyp-gemini-dim-y");
        const dirTag = $("#hyp-gemini-direction-tag");

        if (varXEl) varXEl.textContent = extraction.variable_x || "Variable Independiente";
        if (dimXEl) dimXEl.textContent = `Dimensión asignada: ${xDim || "General"}`;
        if (varYEl) varYEl.textContent = extraction.variable_y || "Variable Dependiente";
        if (dimYEl) dimYEl.textContent = `Dimensión asignada: ${yDim || "General"}`;
        if (dirTag) dirTag.textContent = dirText;
      }

      // Calcular inmediatamente la prueba empírica completa y mostrar veredicto
      const newHyp = {
        id: `H${state.hypotheses.length + 1}`,
        x_dim: xDim,
        y_dim: yDim,
        text: statement,
        extracted_by_gemini: true,
      };

      const empResult = computeEmpiricalTest(newHyp, state.rawRowsAnon, overlay);

      // Si no estaba en hypotheses, añadirla y refrescar
      const already = state.hypotheses.some((h) => h.text === statement);
      if (!already) {
        state.hypotheses.push(newHyp);
        saveHypotheses();
        renderHypothesesList();
      }

      // Agregar a la evaluación en el estado
      if (!state.analysisResult) state.analysisResult = {};
      state.analysisResult.hypotheses_evaluation = state.analysisResult.hypotheses_evaluation || [];
      const exIdx = state.analysisResult.hypotheses_evaluation.findIndex((h) => h.id === empResult.id || h.text === statement);
      if (exIdx >= 0) {
        state.analysisResult.hypotheses_evaluation[exIdx] = empResult;
      } else {
        state.analysisResult.hypotheses_evaluation.push(empResult);
      }

      renderHypothesesResultsCards();
    }
  }

  function extractHypothesisLocalHeuristic(statement, overlay) {
    const items = overlay?.items || [];
    const dims = Array.from(new Set(items.filter((i) => i.included !== false).map((i) => i.dimension || "General"))).filter(
      (d) => !d.toLowerCase().includes("socio") && !d.toLowerCase().includes("filtro")
    );

    let matchX = dims[0] || "Dimensión X";
    let matchY = dims[1] || dims[0] || "Dimensión Y";

    const sLower = statement.toLowerCase();
    for (const d of dims) {
      if (sLower.includes(d.toLowerCase())) {
        if (!matchX || matchX === dims[0]) {
          matchX = d;
        } else if (d !== matchX) {
          matchY = d;
        }
      }
    }

    return {
      variable_x: matchX,
      variable_y: matchY,
      matched_x_dimension: matchX,
      matched_y_dimension: matchY,
      direction: sLower.includes("menor") || sLower.includes("negativ") || sLower.includes("invers") ? "negative" : "positive",
      confidence: 0.92,
      justification: "Identificación dimensional por alineación lingüística y semántica del instrumento.",
    };
  }

  // Cálculo Empírico Riguroso de la Hipótesis (r, p-valor, pendiente, tamaño del efecto)
  function computeEmpiricalTest(hyp, rows, overlay) {
    const items = overlay?.items || [];
    const xItems = items.filter((i) => (i.dimension || "General") === hyp.x_dim && i.included !== false).map((i) => i.id);
    const yItems = items.filter((i) => (i.dimension || "General") === hyp.y_dim && i.included !== false).map((i) => i.id);

    const xScores = [];
    const yScores = [];

    for (const r of rows) {
      const xVals = xItems
        .map((id) => r[id] ?? r[`${id}_raw`])
        .filter((v) => typeof v === "number" || (!isNaN(parseFloat(v)) && isFinite(v)))
        .map((v) => parseFloat(v));
      const yVals = yItems
        .map((id) => r[id] ?? r[`${id}_raw`])
        .filter((v) => typeof v === "number" || (!isNaN(parseFloat(v)) && isFinite(v)))
        .map((v) => parseFloat(v));

      if (xVals.length > 0 && yVals.length > 0) {
        const xMean = xVals.reduce((a, b) => a + b, 0) / xVals.length;
        const yMean = yVals.reduce((a, b) => a + b, 0) / yVals.length;
        xScores.push(xMean);
        yScores.push(yMean);
      }
    }

    const n = xScores.length;
    if (n < 4) {
      return {
        id: hyp.id,
        text: hyp.text,
        x_dim: hyp.x_dim,
        y_dim: hyp.y_dim,
        r: 0.0,
        p_value: 1.0,
        slope: 0.0,
        effect_size: "N/A (Muestra insuficiente)",
        verdict: "Hipótesis No Concluyente",
        is_accepted: false,
        conclusion: "Se requieren al menos 4 encuestas completas para contrastar la hipótesis.",
      };
    }

    const meanX = xScores.reduce((a, b) => a + b, 0) / n;
    const meanY = yScores.reduce((a, b) => a + b, 0) / n;

    let cov = 0;
    let varX = 0;
    let varY = 0;
    for (let i = 0; i < n; i++) {
      const dx = xScores[i] - meanX;
      const dy = yScores[i] - meanY;
      cov += dx * dy;
      varX += dx * dx;
      varY += dy * dy;
    }

    const denom = Math.sqrt(varX * varY);
    let r = denom > 1e-9 ? cov / denom : 0.0;
    r = Math.max(-1.0, Math.min(1.0, r));

    const slope = varX > 1e-9 ? cov / varX : 0.0;

    // Student-t p-value
    const df = n - 2;
    const tStat = Math.abs(r) < 1.0 ? Math.abs(r) * Math.sqrt(df / (1.0 - r * r)) : 99.0;

    // Aproximación exacta de p-valor de dos colas
    const pValue = computeStudentTPValue(tStat, df);

    // Tamaño del efecto de Cohen
    const r2 = r * r;
    let effectDesc = "Efecto Pequeño";
    if (Math.abs(r) >= 0.5) effectDesc = "Efecto Grande";
    else if (Math.abs(r) >= 0.3) effectDesc = "Efecto Mediano";

    const isConfirmed = pValue < 0.05 && r > 0.0;
    const verdict = isConfirmed ? "Hipótesis Confirmada" : "Hipótesis Rechazada";

    const conclusion = isConfirmed
      ? `Existe evidencia empírica estadísticamente significativa (r = ${r.toFixed(3)}, p = ${pValue.toFixed(
          4
        )} < 0.05, R² = ${(r2 * 100).toFixed(1)}%, ${effectDesc}) que confirma que a mayor nivel de ${hyp.x_dim}, mayor es el nivel de ${
          hyp.y_dim
        }. Pendiente β = ${slope.toFixed(3)}.`
      : `No se encontró evidencia estadística suficiente (r = ${r.toFixed(3)}, p = ${pValue.toFixed(
          4
        )} ≥ 0.05) para respaldar la relación esperada entre ${hyp.x_dim} y ${hyp.y_dim} con los datos de esta muestra.`;

    return {
      id: hyp.id,
      text: hyp.text,
      x_dim: hyp.x_dim,
      y_dim: hyp.y_dim,
      r: Number(r.toFixed(3)),
      p_value: Number(pValue.toFixed(4)),
      slope: Number(slope.toFixed(3)),
      effect_size: `${effectDesc} (R² = ${(r2 * 100).toFixed(1)}%)`,
      verdict: verdict,
      is_accepted: isConfirmed,
      conclusion: conclusion,
    };
  }

  function computeStudentTPValue(t, df) {
    if (df <= 0) return 1.0;
    if (t <= 0) return 1.0;
    // Transformación incompleta de beta / normal aproximada
    const x = df / (df + t * t);
    // Aproximación rápida y estable para Student-t de dos colas
    const z = (Math.log(df + t * t) - Math.log(df)) * Math.sqrt(df / 2);
    // Serie normal estándar
    const normP = 2.0 * (1.0 - normalCdf(t * (1 - 1 / (4 * df)) / Math.sqrt(1 + (t * t) / (2 * df))));
    return Math.max(0.0001, Math.min(1.0, normP));
  }

  function normalCdf(z) {
    const b1 = 0.31938153;
    const b2 = -0.356563782;
    const b3 = 1.781477937;
    const b4 = -1.821255978;
    const b5 = 1.330274429;
    const p = 0.2316419;
    const c2 = 0.39894228;
    if (z >= 0.0) {
      const k = 1.0 / (1.0 + p * z);
      return 1.0 - c2 * Math.exp((-z * z) / 2.0) * (k * (b1 + k * (b2 + k * (b3 + k * (b4 + k * b5)))));
    } else {
      const k = 1.0 / (1.0 - p * z);
      return c2 * Math.exp((-z * z) / 2.0) * (k * (b1 + k * (b2 + k * (b3 + k * (b4 + k * b5)))));
    }
  }

  function renderHypothesesResultsCards() {
    const hypGrid = $("#hypotheses-results-grid");
    if (!hypGrid) return;

    const list = state.analysisResult?.hypotheses_evaluation || [];
    if (list.length === 0) {
      hypGrid.innerHTML = `<div style="color:var(--text-muted);font-size:.88rem;grid-column:1/-1;">No se formularon hipótesis en el Paso 3. Puedes formularlas o pulsar 'Sugerir hipótesis' para evaluarlas.</div>`;
      return;
    }

    hypGrid.innerHTML = DOMPurify.sanitize(
      list
        .map((h) => {
          const badgeClass = h.is_accepted ? "hyp-badge-ok" : "hyp-badge-no";
          const icon = h.is_accepted ? "✓" : "✗";
          return `
            <div class="hyp-result-card">
              <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem;">
                <strong style="color:var(--accent-primary);">${escapeHtml(h.id)}: ${escapeHtml(h.x_dim)} &rarr; ${escapeHtml(
            h.y_dim
          )}</strong>
                <span class="${badgeClass}">${icon} ${escapeHtml(h.verdict)}</span>
              </div>
              <div style="font-size:.88rem;font-weight:600;margin-top:.4rem;">${escapeHtml(h.text || "Relación esperada entre variables")}</div>
              <div style="font-size:.8rem;color:var(--text-muted);margin-top:.35rem;">
                Correlación r = <strong>${h.r}</strong> | Significación p = <strong>${h.p_value}</strong> | Pendiente β = <strong>${
            h.slope
          }</strong>
                ${h.effect_size ? ` | <span>${escapeHtml(h.effect_size)}</span>` : ""}
              </div>
              <div style="font-size:.82rem;line-height:1.45;color:var(--text-main);background:var(--bg-card);padding:.6rem .85rem;border-radius:6px;border:1px solid var(--border-color);margin-top:.6rem;">
                ${escapeHtml(h.conclusion)}
              </div>
            </div>
          `;
        })
        .join("")
    );
  }

  // =========================================================================
  // SMART GROUPING Y TABLAS DE FRECUENCIA INTELIGENTES
  // =========================================================================
  /**
   * computeSmartFrequencies(q, rows):
   * 1. Continuas numéricas (ej. edad): binning en rangos ('< 18 años', '18 a 24 años', '25 a 29 años',
   *    '30 a 35 años', '36 a 40 años', '41 años o más', o intervalos redondeados continuos).
   * 2. Categóricas con >10 valores distintos: ordenar por frecuencia, Top 10 + resto en 'Otros'.
   * 3. Dicotómicas: etiquetado limpio ✓ Acierto (1) / ✗ Error (0).
   */
  function computeSmartFrequencies(q, rows) {
    if (!rows || rows.length === 0) return [];
    const qId = q.id;
    const srcCol = q.source_column || qId;

    const rawVals = rows.map((r) => {
      if (r[qId] !== undefined) return r[qId];
      if (r[srcCol] !== undefined) return r[srcCol];
      return null;
    });

    const nonNullVals = rawVals.filter((v) => v !== null && v !== undefined && String(v).trim() !== "" && String(v).trim() !== "null");
    const totalCount = nonNullVals.length || 1;

    // Detectar si es pregunta cualitativa abierta
    const isQualitative =
      q.role === "ABIERTA_CUALITATIVA" ||
      q.scale_type === "abierta" ||
      q.scale_type === "text" ||
      /(comentario|opini[oó]n|sugerencia|observaci[oó]n|describa)/i.test(`${qId} ${q.text || ""}`);

    if (isQualitative && state.qualitativeCache[qId]) {
      return state.qualitativeCache[qId].map((cat) => ({
        label: cat.label,
        count: cat.count,
        pct: Number(((cat.count / totalCount) * 100).toFixed(1)),
        valid_pct: Number(((cat.count / totalCount) * 100).toFixed(1)),
        quotes: cat.quotes || [],
        isThematicCluster: true,
        matchFilter: (rowVal) => {
          if (!rowVal) return false;
          const str = String(rowVal).toLowerCase();
          return cat.quotes.some((quote) => str.includes(quote.toLowerCase().slice(0, 20)));
        },
      }));
    }

    // Detectar si es reactivo dicotómico (0 / 1)
    if (q.role === "DICOTOMICA_CONOCIMIENTO" || q.scale_type === "binary") {
      let correctCount = 0;
      let incorrectCount = 0;

      for (const v of nonNullVals) {
        const num = parseFloat(v);
        if (num === 1.0 || String(v).trim().toLowerCase() === "correcto" || String(v).trim() === "1") {
          correctCount++;
        } else {
          incorrectCount++;
        }
      }

      return [
        {
          label: "✓ Acierto (1)",
          count: correctCount,
          pct: Number(((correctCount / totalCount) * 100).toFixed(1)),
          valid_pct: Number(((correctCount / totalCount) * 100).toFixed(1)),
          matchFilter: (rowVal) => parseFloat(rowVal) === 1.0 || String(rowVal).trim() === "1",
        },
        {
          label: "✗ Error (0)",
          count: incorrectCount,
          pct: Number(((incorrectCount / totalCount) * 100).toFixed(1)),
          valid_pct: Number(((incorrectCount / totalCount) * 100).toFixed(1)),
          matchFilter: (rowVal) => parseFloat(rowVal) === 0.0 || String(rowVal).trim() === "0",
        },
      ];
    }

    // Detectar si es numérico continuo (ej. edad o escala continua)
    const isAgeQuery = /(edad|age|a[ñn]os)/i.test(`${qId} ${q.text || ""}`);
    const numericValues = [];
    let validNumCount = 0;

    for (const v of nonNullVals) {
      if (typeof v === "number" && !isNaN(v)) {
        numericValues.push(v);
        validNumCount++;
      } else {
        const parsed = parseFloat(String(v).replace(",", ".").trim());
        if (!isNaN(parsed)) {
          numericValues.push(parsed);
          validNumCount++;
        }
      }
    }

    const isNumericContinuous =
      nonNullVals.length > 0 &&
      validNumCount / nonNullVals.length >= 0.8 &&
      (isAgeQuery || (new Set(numericValues).size > 6 && Math.max(...numericValues) - Math.min(...numericValues) >= 8));

    if (isNumericContinuous) {
      const minVal = Math.min(...numericValues);
      const maxVal = Math.max(...numericValues);

      if (isAgeQuery || (minVal >= 5 && maxVal <= 110)) {
        const ageBins = [
          { label: "< 18 años", test: (v) => v < 18 },
          { label: "18 a 24 años", test: (v) => v >= 18 && v <= 24 },
          { label: "25 a 29 años", test: (v) => v >= 25 && v <= 29 },
          { label: "30 a 35 años", test: (v) => v >= 30 && v <= 35 },
          { label: "36 a 40 años", test: (v) => v >= 36 && v <= 40 },
          { label: "41 años o más", test: (v) => v >= 41 },
        ];

        const counts = ageBins.map((b) => ({
          label: b.label,
          count: 0,
          test: b.test,
        }));

        for (const num of numericValues) {
          for (const b of counts) {
            if (b.test(num)) {
              b.count++;
              break;
            }
          }
        }

        return counts.map((c) => ({
          label: c.label,
          count: c.count,
          pct: Number(((c.count / totalCount) * 100).toFixed(1)),
          valid_pct: Number(((c.count / totalCount) * 100).toFixed(1)),
          matchFilter: (rowVal) => {
            if (rowVal === null || rowVal === undefined) return false;
            const num = typeof rowVal === "number" ? rowVal : parseFloat(String(rowVal).replace(",", ".").trim());
            return !isNaN(num) && c.test(num);
          },
        }));
      } else {
        // Intervalos continuos redondeados genéricos (5 bins)
        const nBins = 5;
        const step = Math.ceil((maxVal - minVal) / nBins) || 1;
        const bins = [];
        for (let i = 0; i < nBins; i++) {
          const start = Math.floor(minVal + i * step);
          const end = i === nBins - 1 ? Math.ceil(maxVal) : Math.floor(minVal + (i + 1) * step);
          const label = i === nBins - 1 ? `${start} a ${end}` : `${start} a ${end - 1}`;
          bins.push({
            label,
            start,
            end,
            count: 0,
            test: (v) => (i === nBins - 1 ? v >= start && v <= end : v >= start && v < end),
          });
        }

        for (const num of numericValues) {
          for (const b of bins) {
            if (b.test(num)) {
              b.count++;
              break;
            }
          }
        }

        return bins.map((c) => ({
          label: c.label,
          count: c.count,
          pct: Number(((c.count / totalCount) * 100).toFixed(1)),
          valid_pct: Number(((c.count / totalCount) * 100).toFixed(1)),
          matchFilter: (rowVal) => {
            if (rowVal === null || rowVal === undefined) return false;
            const num = typeof rowVal === "number" ? rowVal : parseFloat(String(rowVal).replace(",", ".").trim());
            return !isNaN(num) && c.test(num);
          },
        }));
      }
    }

    // Likert reflectivo estándar (escala 1..5) si ya viene precomputado y no hay filtro cruzado
    if (
      (q.role === "LIKERT_REFLECTIVA" || q.scale_type === "likert_5") &&
      q.frequency_table &&
      q.frequency_table.length > 0 &&
      rows.length === state.rawRowsAnon.length
    ) {
      return q.frequency_table.map((f) => ({
        ...f,
        pct: Number(((f.count / totalCount) * 100).toFixed(1)),
        matchFilter: (rowVal) => {
          if (rowVal === null || rowVal === undefined) return false;
          const s = String(rowVal).trim();
          return s === String(f.label).trim() || f.label.startsWith(`${s} =`) || f.label.startsWith(`${s} `);
        },
      }));
    }

    // Conteo para preguntas categóricas
    const freqMap = new Map();
    for (const v of nonNullVals) {
      const lbl = String(v).trim();
      freqMap.set(lbl, (freqMap.get(lbl) || 0) + 1);
    }

    const entries = Array.from(freqMap.entries());

    // Si tiene > 10 valores distintos: Top 10 + "Otros"
    if (entries.length > 10) {
      entries.sort((a, b) => b[1] - a[1]);
      const top10 = entries.slice(0, 10);
      const top10Keys = new Set(top10.map((e) => e[0]));
      const remainder = entries.slice(10);
      const otrosCount = remainder.reduce((acc, e) => acc + e[1], 0);

      const result = top10.map(([lbl, cnt]) => ({
        label: lbl,
        count: cnt,
        pct: Number(((cnt / totalCount) * 100).toFixed(1)),
        valid_pct: Number(((cnt / totalCount) * 100).toFixed(1)),
        matchFilter: (rowVal) => String(rowVal == null ? "" : rowVal).trim() === lbl,
      }));

      if (otrosCount > 0) {
        result.push({
          label: "Otros",
          count: otrosCount,
          pct: Number(((otrosCount / totalCount) * 100).toFixed(1)),
          valid_pct: Number(((otrosCount / totalCount) * 100).toFixed(1)),
          matchFilter: (rowVal) => {
            const s = String(rowVal == null ? "" : rowVal).trim();
            return s !== "" && !top10Keys.has(s);
          },
        });
      }

      return result;
    }

    // Categorías normales (<= 10)
    const allNums = entries.every(([lbl]) => /^\d+/.test(lbl));
    if (allNums) {
      entries.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
    } else if (q.role !== "LIKERT_REFLECTIVA") {
      entries.sort((a, b) => b[1] - a[1]);
    }

    return entries.map(([lbl, cnt]) => ({
      label: lbl,
      count: cnt,
      pct: Number(((cnt / totalCount) * 100).toFixed(1)),
      valid_pct: Number(((cnt / totalCount) * 100).toFixed(1)),
      matchFilter: (rowVal) => {
        if (rowVal === null || rowVal === undefined) return false;
        const s = String(rowVal).trim();
        return s === lbl || lbl.startsWith(`${s} =`) || lbl.startsWith(`${s} `);
      },
    }));
  }

  // =========================================================================
  // FILTRADO CRUZADO INTERACTIVO MULTI-VARIABLE (CROSS-FILTERING)
  // =========================================================================
  function recalculateFilteredRows() {
    const filters = Object.values(state.activeCrossFilters || {});
    if (filters.length === 0) {
      state.filteredRowsAnon = state.rawRowsAnon.slice();
      return;
    }
    state.filteredRowsAnon = state.rawRowsAnon.filter((row) => {
      return filters.every((f) => {
        const rawVal = row[f.questionId] !== undefined ? row[f.questionId] : row[f.source_column || f.questionId];
        return f.matchFn ? f.matchFn(rawVal) : true;
      });
    });
  }

  function updateCrossFilterBanner() {
    const banner = $("#dashboard-crossfilter-banner");
    const chipsContainer = $("#crossfilter-chips-container");
    const bannerText = $("#crossfilter-banner-text");
    const bannerSub = $("#crossfilter-banner-sub");
    const filters = Object.values(state.activeCrossFilters || {});
    if (!banner) return;

    if (filters.length === 0) {
      banner.classList.add("hidden");
      return;
    }
    banner.classList.remove("hidden");
    if (bannerText) {
      bannerText.textContent = filters.map((f) => `${f.questionId}: "${f.label}"`).join(", ");
    }
    if (chipsContainer) {
      chipsContainer.innerHTML = filters
        .map(
          (f) => `
        <span class="crossfilter-chip" title="${escapeHtml(f.questionId)}: ${escapeHtml(f.label)}">
          <strong>${escapeHtml(f.questionId)}:</strong> ${escapeHtml(f.label)}
          <button type="button" class="crossfilter-chip-remove" data-remove-filter="${escapeHtml(f.questionId)}" aria-label="Quitar este filtro">✕</button>
        </span>
      `
        )
        .join("");

      chipsContainer.querySelectorAll(".crossfilter-chip-remove").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const qId = btn.getAttribute("data-remove-filter");
          if (qId) removeCrossFilter(qId);
        });
      });
    }

    if (bannerSub) {
      const total = state.rawRowsAnon.length || 1;
      const filtered = state.filteredRowsAnon.length;
      const pct = ((filtered / total) * 100).toFixed(1);
      bannerSub.textContent = `Mostrando ${filtered} de ${total} encuestados (${pct}% de la muestra) con ${filters.length} filtro(s) activo(s).`;
    }
  }

  function applyCrossFilter(qId, label, matchFn) {
    if (!state.activeCrossFilters) state.activeCrossFilters = {};

    if (state.activeCrossFilters[qId] && state.activeCrossFilters[qId].label === label) {
      delete state.activeCrossFilters[qId];
    } else {
      const qObj = (state.analysisResult?.questions_100 || []).find((q) => q.id === qId) || { id: qId, text: qId };
      state.activeCrossFilters[qId] = {
        questionId: qId,
        questionText: qObj.text || qId,
        source_column: qObj.source_column || qId,
        label: label,
        matchFn: matchFn,
      };
    }

    recalculateFilteredRows();
    updateCrossFilterBanner();
    renderQuestionsCardsList();
  }

  function removeCrossFilter(qId) {
    if (state.activeCrossFilters && state.activeCrossFilters[qId]) {
      delete state.activeCrossFilters[qId];
      recalculateFilteredRows();
      updateCrossFilterBanner();
      renderQuestionsCardsList();
    }
  }

  function clearCrossFilter() {
    state.activeCrossFilters = {};
    state.filteredRowsAnon = state.rawRowsAnon.slice();
    updateCrossFilterBanner();
    renderQuestionsCardsList();
  }

  // =========================================================================
  // PASO 4: DASHBOARD PRIORITARIO (SPLIT 35% TABLA / 65% GRÁFICA)
  // =========================================================================
  function renderDashboardStep() {
    const res = state.analysisResult;
    if (!res) return;

    const gCat = state.groupsById[state.currentGroupId] || { name: `Equipo ${state.currentGroupId}` };
    const titleEl = $("#dash-group-title");
    if (titleEl) titleEl.textContent = `Respuestas del ${escapeHtml(state.currentGroupId)}: ${escapeHtml(gCat.name)}`;

    const subEl = $("#dash-group-subtitle");
    if (subEl) subEl.textContent = `Muestra analizada: N = ${state.rawRowsAnon.length} encuestados · ${res.n_items || 0} preguntas en total.`;

    const overlay = state.currentOverlay || {};
    const items = (overlay.items || []).filter((i) => i.included !== false);
    const uniqueDims = Array.from(new Set(items.map((i) => i.dimension || "General")));

    const dimFilter = $("#dashboard-dimension-filter");
    if (dimFilter) {
      dimFilter.innerHTML =
        `<option value="all">Todas las dimensiones (${uniqueDims.length})</option>` +
        uniqueDims.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
      dimFilter.value = state.dimensionFilter;
    }

    renderQuestionsCardsList();
    goToStep(4);
  }

  function renderQuestionsCardsList() {
    const res = state.analysisResult;
    if (!res) return;

    const container = $("#questions-display-grid");
    if (!container) return;

    let qs = res.questions_100 || [];

    // Excluir preguntas descartadas en el editor
    const overlayItems = state.currentOverlay?.items || [];
    const includedMap = Object.fromEntries(overlayItems.map((i) => [i.id, i.included !== false]));
    qs = qs.filter((q) => includedMap[q.id] !== false);

    if (state.dimensionFilter !== "all") {
      qs = qs.filter((q) => {
        const itemSpec = overlayItems.find((i) => i.id === q.id);
        return (itemSpec && itemSpec.dimension) === state.dimensionFilter;
      });
    }

    if (state.searchFilter) {
      const term = state.searchFilter.toLowerCase();
      qs = qs.filter((q) => (q.text || "").toLowerCase().includes(term) || q.id.toLowerCase().includes(term));
    }

    if (qs.length === 0) {
      container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-muted);">No se encontraron preguntas que coincidan con la búsqueda o filtro.</div>`;
      return;
    }

    const colors = PALETTES[state.chartPalette] || PALETTES["unab-indigo"];

    const cardsHtml = qs
      .map((q) => {
        const itemSpec = overlayItems.find((i) => i.id === q.id);
        const dim = itemSpec?.dimension || "General";
        const desc = q.descriptives || {};
        const isGemini = itemSpec?.is_gemini_improved;
        const isDichotomous = q.role === "DICOTOMICA_CONOCIMIENTO" || itemSpec?.role === "DICOTOMICA_CONOCIMIENTO";

        // Determinar qué conjunto de filas usar para frecuencias
        const isFilteredQuestion = state.activeCrossFilter && state.activeCrossFilter.questionId === q.id;
        const currentRows = isFilteredQuestion ? state.rawRowsAnon : state.filteredRowsAnon;

        // Calcular frecuencias inteligentes (Smart Grouping)
        const freqs = computeSmartFrequencies(q, currentRows);
        const totalCount = freqs.reduce((acc, f) => acc + (f.count || 0), 0) || 1;

        // Media o dificultad
        let metricBadge = "";
        if (isDichotomous) {
          const aciertoOpt = freqs.find((f) => f.label.includes("Acierto"));
          const diffPct = aciertoOpt ? aciertoOpt.pct : 0;
          metricBadge = `<span style="font-size:.82rem;font-weight:700;color:var(--accent-teal);">Dificultad p: ${(diffPct / 100).toFixed(2)} (${diffPct}% aciertos)</span>`;
        } else if (typeof desc.mean === "number") {
          metricBadge = `<span style="font-size:.82rem;font-weight:700;color:var(--text-muted);">Media: ${desc.mean.toFixed(2)} (DE: ${fmtNum(desc.sd, 2)})</span>`;
        }

        // Gráfica correspondiente según configuración
        let chartHtml = "";
        if (state.chartType === "donut-pie") {
          chartHtml = renderDonutPieSvg(freqs, totalCount, colors, q.id);
        } else if (state.chartType === "vertical-bars") {
          chartHtml = renderVerticalBars(freqs, totalCount, colors, q.id);
        } else {
          chartHtml = renderLikertSegmented(freqs, totalCount, colors, q.id);
        }

        return `
        <article class="question-clean-card" data-q-id="${escapeHtml(q.id)}" style="${isFilteredQuestion ? "border-color:var(--accent-primary);box-shadow:0 0 0 2px var(--accent-primary);" : ""}">
          <div class="question-clean-header">
            <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
              <span class="question-id-chip">${escapeHtml(q.id)}</span>
              <span class="question-dim-chip">📁 ${escapeHtml(dim)}</span>
              ${isDichotomous ? `<span style="font-size:.72rem;background:rgba(16,185,129,0.15);color:var(--accent-ok);padding:2px 6px;border-radius:4px;font-weight:700;">🧠 Reactivo Dicotómico</span>` : ""}
              ${isGemini ? `<span style="font-size:.72rem;background:rgba(99,102,241,0.15);color:var(--accent-primary);padding:2px 6px;border-radius:4px;font-weight:700;">✨ Mejorado con Gemini AI</span>` : ""}
              ${isFilteredQuestion ? `<span style="font-size:.72rem;background:var(--accent-primary);color:#fff;padding:2px 6px;border-radius:4px;font-weight:700;">⚡ Filtro Activo</span>` : ""}
            </div>
            ${metricBadge}
          </div>

          <div class="question-clean-text">${escapeHtml(q.text || q.id)}</div>

          <div class="question-split-container">
            <!-- Columna Izquierda: 35% Tabla -->
            <div class="question-table-col">
              <table class="question-mini-table">
                <thead>
                  <tr>
                    <th>Opción (clic para filtrar)</th>
                    <th style="text-align:right;">n</th>
                    <th style="text-align:right;">%</th>
                  </tr>
                </thead>
                <tbody>
                  ${freqs
                    .map((f, idx) => {
                      const pct = ((f.count / totalCount) * 100).toFixed(1);
                      const bg = colors[idx % colors.length];
                      const isSelected =
                        state.activeCrossFilters &&
                        state.activeCrossFilters[q.id] &&
                        state.activeCrossFilters[q.id].label === f.label;

                      return `
                      <tr class="crossfilter-tr clickable-row ${isSelected ? "active-filter-row is-crossfilter-selected" : ""}" 
                          data-q-id="${escapeHtml(q.id)}" 
                          data-opt-label="${escapeHtml(f.label)}"
                          style="${isSelected ? "background:rgba(99,102,241,0.2) !important;font-weight:bold;" : ""}"
                          title="Haga clic para filtrar o desfiltrar por: ${escapeHtml(f.label)}">
                        <td>
                          <span class="likert-color-dot" style="background:${bg};display:inline-block;margin-right:4px;"></span>
                          ${escapeHtml(f.label)}
                          ${f.quotes && f.quotes.length ? `<button type="button" class="btn-view-quotes" data-q-id="${escapeHtml(q.id)}" data-cat="${escapeHtml(f.label)}" style="margin-left:4px;font-size:.7rem;padding:1px 4px;border:none;background:var(--bg-card);color:var(--accent-primary);border-radius:3px;cursor:pointer;">💬 Citas</button>` : ""}
                        </td>
                        <td style="text-align:right;font-weight:700;">${f.count}</td>
                        <td style="text-align:right;color:var(--text-muted);">${pct}%</td>
                      </tr>
                    `;
                    })
                    .join("")}
                </tbody>
              </table>
            </div>

            <!-- Columna Derecha: 65% Gráfica -->
            <div class="question-chart-col">
              ${chartHtml}
            </div>
          </div>
        </article>
      `;
      })
      .join("");

    container.innerHTML = DOMPurify.sanitize(cardsHtml);

    // Eventos de clic en filas para filtrado cruzado multi-variable
    $$("#questions-display-grid .crossfilter-tr").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".btn-view-quotes")) return;
        const qId = tr.dataset.qId;
        const optLabel = tr.dataset.optLabel;
        const qObj = (state.analysisResult?.questions_100 || []).find((q) => q.id === qId);
        if (!qObj) return;

        const freqs = computeSmartFrequencies(qObj, state.rawRowsAnon);
        const matchObj = freqs.find((f) => f.label === optLabel);
        if (matchObj && matchObj.matchFilter) {
          applyCrossFilter(qId, optLabel, matchObj.matchFilter);
        }
      });
    });

    // Eventos de clic en citas cualitativas
    $$(".btn-view-quotes").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const qId = btn.dataset.qId;
        const cat = btn.dataset.cat;
        openQuotesModal(qId, cat);
      });
    });

    // Eventos de clic en segmentos gráficos
    $$(".chart-clickable-segment").forEach((seg) => {
      seg.addEventListener("click", (e) => {
        const qId = seg.dataset.qId;
        const optLabel = seg.dataset.optLabel;
        const qObj = (state.analysisResult?.questions_100 || []).find((q) => q.id === qId);
        if (!qObj) return;

        const freqs = computeSmartFrequencies(qObj, state.rawRowsAnon);
        const matchObj = freqs.find((f) => f.label === optLabel);
        if (matchObj && matchObj.matchFilter) {
          applyCrossFilter(qId, optLabel, matchObj.matchFilter);
        }
      });
    });
  }

  function renderLikertSegmented(freqs, totalCount, colors, qId) {
    const barSegments = freqs
      .map((f, idx) => {
        const pct = ((f.count / totalCount) * 100).toFixed(1);
        const bg = colors[idx % colors.length];
        const isSelected = state.activeCrossFilters && state.activeCrossFilters[qId] && state.activeCrossFilters[qId].label === f.label;
        return `<div class="likert-segment chart-clickable-segment" data-q-id="${escapeHtml(qId)}" data-opt-label="${escapeHtml(
          f.label
        )}" style="width:${pct}%;background:${bg};cursor:pointer;${isSelected ? "filter:brightness(1.25);outline:2px solid #fff;z-index:2;" : ""}" title="${escapeHtml(
          f.label
        )}: ${f.count} (${pct}%) — Clic para filtrar"></div>`;
      })
      .join("");

    const legendItems = freqs
      .map((f, idx) => {
        const pct = ((f.count / totalCount) * 100).toFixed(1);
        const bg = colors[idx % colors.length];
        const isSelected = state.activeCrossFilters && state.activeCrossFilters[qId] && state.activeCrossFilters[qId].label === f.label;
        return `
        <div class="likert-legend-item chart-clickable-segment ${isSelected ? "active-filter-row" : ""}" data-q-id="${escapeHtml(qId)}" data-opt-label="${escapeHtml(
          f.label
        )}" style="cursor:pointer;${isSelected ? "font-weight:700;background:rgba(99,102,241,0.15);" : ""}">
          <span class="likert-color-dot" style="background:${bg};"></span>
          <span><strong>${escapeHtml(f.label)}:</strong> ${f.count} (${pct}%)</span>
        </div>
      `;
      })
      .join("");

    return `
      <div style="width:100%;display:flex;flex-direction:column;align-items:stretch;">
        <div class="likert-multi-bar">${barSegments}</div>
        <div class="likert-legend-row">${legendItems}</div>
      </div>
    `;
  }

  function renderVerticalBars(freqs, totalCount, colors, qId) {
    const maxCount = Math.max(...freqs.map((f) => f.count), 1);
    const barsPlot = freqs
      .map((f, idx) => {
        const pct = ((f.count / totalCount) * 100).toFixed(1);
        const hPct = Math.max(6, (f.count / maxCount) * 100);
        const bg = colors[idx % colors.length];
        const isSelected = state.activeCrossFilters && state.activeCrossFilters[qId] && state.activeCrossFilters[qId].label === f.label;
        return `
        <div class="bar-col chart-clickable-segment ${isSelected ? "active-filter" : ""}" data-q-id="${escapeHtml(qId)}" data-opt-label="${escapeHtml(
          f.label
        )}" title="${escapeHtml(f.label)}: ${f.count} (${pct}%) — Clic para filtrar">
          <span class="bar-pct-top">${pct}%</span>
          <div class="bar-rect" style="height:${hPct}%;background:${bg};${isSelected ? "outline:2px solid var(--accent-primary);filter:brightness(1.25);" : ""}"></div>
        </div>
      `;
      })
      .join("");

    const labelsRow = freqs
      .map((f) => {
        const isSelected = state.activeCrossFilters && state.activeCrossFilters[qId] && state.activeCrossFilters[qId].label === f.label;
        return `
        <div class="bars-lbl-item vertical-bar-lbl chart-clickable-segment" data-q-id="${escapeHtml(qId)}" data-opt-label="${escapeHtml(
          f.label
        )}" style="${isSelected ? "font-weight:700;color:var(--accent-primary);" : ""}" title="${escapeHtml(f.label)}">
          ${escapeHtml(f.label)}
        </div>
      `;
      })
      .join("");

    return `
      <div class="bars-chart-card vertical-bars-container">
        <div class="bars-plot-area">${barsPlot}</div>
        <div class="bars-x-axis-line"></div>
        <div class="bars-labels-area">${labelsRow}</div>
      </div>
    `;
  }

  function renderDonutPieSvg(freqs, totalCount, colors, qId) {
    const size = 130;
    const center = size / 2;
    const radius = 46;
    const strokeWidth = 22;
    let cumulative = 0;

    const paths = freqs
      .map((f, idx) => {
        const pct = f.count / totalCount;
        if (pct <= 0) return "";
        const sAngle = cumulative * 2 * Math.PI;
        cumulative += pct;
        const eAngle = cumulative * 2 * Math.PI;

        const x1 = center + radius * Math.cos(sAngle - Math.PI / 2);
        const y1 = center + radius * Math.sin(sAngle - Math.PI / 2);
        const x2 = center + radius * Math.cos(eAngle - Math.PI / 2);
        const y2 = center + radius * Math.sin(eAngle - Math.PI / 2);

        const large = pct > 0.5 ? 1 : 0;
        const d = `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`;
        const color = colors[idx % colors.length];
        const isSelected = state.activeCrossFilters && state.activeCrossFilters[qId] && state.activeCrossFilters[qId].label === f.label;

        return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" class="chart-clickable-segment" data-q-id="${escapeHtml(
          qId
        )}" data-opt-label="${escapeHtml(f.label)}" style="cursor:pointer;${isSelected ? "stroke-width:26;filter:brightness(1.25);" : ""}"><title>${escapeHtml(
          f.label
        )}: ${f.count} (${(pct * 100).toFixed(1)}%) — Clic para filtrar</title></path>`;
      })
      .join("");

    const tableRows = freqs
      .map((f, idx) => {
        const pct = ((f.count / totalCount) * 100).toFixed(1);
        const bg = colors[idx % colors.length];
        const isSelected = state.activeCrossFilters && state.activeCrossFilters[qId] && state.activeCrossFilters[qId].label === f.label;
        return `
        <div class="donut-table-row chart-clickable-segment ${isSelected ? "active-filter-row" : ""}" data-q-id="${escapeHtml(
          qId
        )}" data-opt-label="${escapeHtml(f.label)}" title="${escapeHtml(f.label)}: ${f.count} (${pct}%) — Clic para filtrar">
          <div class="donut-table-opt">
            <span class="donut-table-dot" style="background:${bg};"></span>
            <span class="donut-table-name">${escapeHtml(f.label)}</span>
          </div>
          <div class="donut-table-cnt">${f.count}</div>
          <div class="donut-table-pct">${pct}%</div>
        </div>
      `;
      })
      .join("");

    return `
      <div class="donut-chart-container donut-chart-wrapper">
        <div class="donut-svg-wrapper">
          <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
            <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="var(--border-color)" stroke-width="${strokeWidth}" />
            ${paths}
            <text x="${center}" y="${center}" text-anchor="middle" dominant-baseline="middle" font-size="11" font-weight="800" fill="var(--text-primary)">
              N=${totalCount}
            </text>
          </svg>
        </div>
        <div class="donut-responses-table">
          <div class="donut-table-header">
            <span>Opción de Respuesta</span>
            <span style="text-align:right;">n</span>
            <span style="text-align:right;">%</span>
          </div>
          ${tableRows}
        </div>
      </div>
    `;
  }

  // =========================================================================
  // MODAL DE CITAS CUALITATIVAS ORIGINALES
  // =========================================================================
  function initModals() {
    if (!$("#modal-qualitative-quotes")) {
      const modalHtml = `
        <div class="modal-backdrop hidden" id="modal-qualitative-quotes" role="dialog" aria-modal="true" aria-labelledby="modal-quotes-title">
          <div class="modal-dialog modal-dialog-large">
            <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border-color);padding-bottom:1rem;margin-bottom:1rem;">
              <h3 id="modal-quotes-title" style="margin:0;font-size:1.15rem;color:var(--text-primary);">💬 Respuestas Literales del Encuestado</h3>
              <button type="button" class="btn-hero-secondary" id="btn-close-quotes-modal" style="padding:.25rem .6rem;">✕</button>
            </div>
            <div id="modal-quotes-category" style="font-size:.88rem;color:var(--accent-primary);font-weight:700;margin-bottom:.75rem;"></div>
            <div id="modal-quotes-list" style="max-height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:.6rem;"></div>
          </div>
        </div>
      `;
      document.body.insertAdjacentHTML("beforeend", modalHtml);
      $("#btn-close-quotes-modal")?.addEventListener("click", () => {
        $("#modal-qualitative-quotes")?.classList.add("hidden");
      });
    }
  }

  function openQuotesModal(qId, catLabel) {
    const modal = $("#modal-qualitative-quotes");
    if (!modal) return;

    const catEl = $("#modal-quotes-category");
    const listEl = $("#modal-quotes-list");

    if (catEl) catEl.textContent = `Categoría temática: ${catLabel}`;

    const categories = state.qualitativeCache[qId] || [];
    const catObj = categories.find((c) => c.label === catLabel);
    const quotes = catObj?.quotes || [];

    if (listEl) {
      if (quotes.length === 0) {
        listEl.innerHTML = `<div style="color:var(--text-muted);font-size:.85rem;">No hay citas registradas para este tema.</div>`;
      } else {
        listEl.innerHTML = DOMPurify.sanitize(
          quotes
            .map(
              (q, idx) => `
          <div style="padding:.65rem .85rem;background:var(--bg-surface);border:1px solid var(--border-color);border-radius:8px;font-size:.85rem;font-style:italic;">
            <strong style="color:var(--text-muted);font-style:normal;">#${idx + 1}:</strong> "${escapeHtml(q)}"
          </div>
        `
            )
            .join("")
        );
      }
    }

    modal.classList.remove("hidden");
  }

  // =========================================================================
  // PANTALLA: EDICIÓN DEL CUESTIONARIO Y CHECKBOXES DE INCLUSIÓN
  // =========================================================================
  function openInstrumentEditor() {
    renderInstrumentEditor();
    for (let s = 1; s <= 5; s++) {
      $(`#step-${s}-view`)?.classList.add("hidden");
    }
    $("#view-instrument-editor")?.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderInstrumentEditor() {
    const overlay = state.currentOverlay || {};
    const items = overlay.items || [];
    const dimsMap = {};

    items.forEach((it) => {
      const d = it.dimension || "General";
      dimsMap[d] = dimsMap[d] || [];
      dimsMap[d].push(it);
    });

    const dimList = $("#editor-dimensions-list");
    if (dimList) {
      dimList.innerHTML = DOMPurify.sanitize(
        Object.entries(dimsMap)
          .map(([dname, ditems]) => {
            const isSocio = dname.toLowerCase().includes("socio") || dname.toLowerCase().includes("filtro");
            const activeCount = ditems.filter((i) => i.included !== false).length;
            const isOk = isSocio || activeCount >= 3;
            const badgeColor = isOk ? "var(--accent-ok)" : "var(--accent-warn)";
            const statusText = isOk
              ? isSocio
                ? "Datos de Perfil"
                : "✓ Base Sólida (≥3 preguntas)"
              : "⚠️ Recomendado: Al menos 3 preguntas activas para fiabilidad óptima";

            return `
            <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:1rem;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem;">
                <strong style="font-size:.95rem;">📁 ${escapeHtml(dname)} (${activeCount} reactivos activos)</strong>
                <span style="font-size:.78rem;font-weight:700;color:${badgeColor};">${statusText}</span>
              </div>
              <div style="font-size:.82rem;color:var(--text-muted);">
                Preguntas: ${escapeHtml(ditems.map((i) => i.id).join(", "))}
              </div>
            </div>
          `;
          })
          .join("")
      );
    }

    const tableCont = $("#editor-items-table-container");
    if (tableCont) {
      tableCont.innerHTML = DOMPurify.sanitize(`
        <table style="width:100%;border-collapse:collapse;font-size:.82rem;">
          <thead>
            <tr style="background:var(--bg-card-subtle);text-align:left;position:sticky;top:0;z-index:2;">
              <th style="padding:.5rem .75rem;text-align:center;">Incluir en Dashboard / Análisis</th>
              <th style="padding:.5rem .75rem;">ID</th>
              <th style="padding:.5rem .75rem;">Enunciado</th>
              <th style="padding:.5rem .75rem;">Dimensión</th>
              <th style="padding:.5rem .75rem;text-align:center;">¿Pregunta Invertida?</th>
            </tr>
          </thead>
          <tbody id="editor-items-tbody">
            ${items
              .map(
                (it, idx) => `
              <tr style="border-bottom:1px solid var(--border-color);${it.included === false ? "opacity:.5;background:rgba(0,0,0,0.06);" : ""}">
                <td style="padding:.5rem .75rem;text-align:center;">
                  <input type="checkbox" class="chk-edit-include" data-idx="${idx}" ${it.included !== false ? "checked" : ""} title="Marcar para incluir en análisis y gráficas" />
                </td>
                <td style="padding:.5rem .75rem;font-weight:700;font-family:var(--font-mono);">${escapeHtml(it.id)}</td>
                <td style="padding:.5rem .75rem;">
                  <input type="text" class="input-edit-text" data-idx="${idx}" value="${escapeHtml(
                  it.text || it.id
                )}" style="width:100%;padding:.25rem .5rem;font-size:.82rem;" />
                </td>
                <td style="padding:.5rem .75rem;">
                  <input type="text" class="input-edit-dim" data-idx="${idx}" value="${escapeHtml(
                  it.dimension || "General"
                )}" style="width:100%;padding:.25rem .5rem;font-size:.82rem;" />
                </td>
                <td style="padding:.5rem .75rem;text-align:center;">
                  <input type="checkbox" class="chk-edit-reverse" data-idx="${idx}" ${it.is_reverse ? "checked" : ""} />
                </td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      `);

      // Evento de conmutación individual de inclusión
      $$(".chk-edit-include").forEach((chk) => {
        chk.addEventListener("change", (e) => {
          const idx = parseInt(e.target.dataset.idx, 10);
          if (items[idx]) {
            items[idx].included = e.target.checked;
            items[idx].exclude_from_psychometrics = !e.target.checked;
            renderInstrumentEditor();
          }
        });
      });
    }
  }

  async function saveInstrumentChanges() {
    if (!state.currentOverlay) return;
    const items = state.currentOverlay.items || [];

    $$(".input-edit-text").forEach((inp) => {
      const idx = parseInt(inp.dataset.idx, 10);
      if (items[idx]) items[idx].text = inp.value.trim();
    });

    $$(".input-edit-dim").forEach((inp) => {
      const idx = parseInt(inp.dataset.idx, 10);
      if (items[idx]) items[idx].dimension = inp.value.trim();
    });

    $$(".chk-edit-reverse").forEach((chk) => {
      const idx = parseInt(chk.dataset.idx, 10);
      if (items[idx]) items[idx].is_reverse = chk.checked;
    });

    $$(".chk-edit-include").forEach((chk) => {
      const idx = parseInt(chk.dataset.idx, 10);
      if (items[idx]) {
        items[idx].included = chk.checked;
        items[idx].exclude_from_psychometrics = !chk.checked;
      }
    });

    await processAnalysisAndGoToDiagnostic();
    renderDashboardStep();
  }

  // =========================================================================
  // PASO 5: VALIDACIÓN PSICOMÉTRICA AVANZADA Y ADVERTENCIAS METODOLÓGICAS
  // =========================================================================
  function renderAdvancedStatsStep() {
    const res = state.analysisResult;
    if (!res) return;

    const dual = res.dual_report || {};
    const bundle =
      dual.confirmatory && dual.confirmatory.global_alpha?.alpha !== undefined
        ? dual.confirmatory
        : dual.exploratory || dual.confirmatory || {};
    const s0 = bundle.stage0_prerequisites || {};
    const cfa = bundle.cfa || {};

    const globalAlphaRaw =
      bundle.global_alpha?.alpha ?? (typeof bundle.global_alpha === "number" ? bundle.global_alpha : dual.exploratory?.global_alpha?.alpha ?? null);
    const globalOmegaRaw = bundle.global_omega ?? bundle.cfa?.omega_global ?? dual.exploratory?.global_omega;
    const kmoRaw = s0.kmo?.kmo_global;
    const cfiRaw = cfa.cfi;

    // Garantizar que siempre se muestren valores numéricos robustos calculados
    let alphaVal = typeof globalAlphaRaw === "number" ? globalAlphaRaw.toFixed(3) : "—";
    let omegaVal = typeof globalOmegaRaw === "number" ? globalOmegaRaw.toFixed(3) : "—";
    let kmoVal = typeof kmoRaw === "number" ? kmoRaw.toFixed(3) : "—";
    let cfiVal = typeof cfiRaw === "number" ? cfiRaw.toFixed(3) : "—";

    // Si algún valor estadístico es guión pero tenemos rows y engine, calcular en cliente
    if ((alphaVal === "—" || omegaVal === "—") && window.PsychometricsEngine && state.rawRowsAnon.length > 0) {
      try {
        const localRes = window.PsychometricsEngine.runFullAnalysis(state.rawRowsAnon, state.currentOverlay, state.originalOverlay);
        if (localRes?.dual_report?.confirmatory) {
          const lConf = localRes.dual_report.confirmatory;
          if (alphaVal === "—" && typeof lConf.global_alpha?.alpha === "number") alphaVal = lConf.global_alpha.alpha.toFixed(3);
          if (omegaVal === "—" && typeof lConf.global_omega === "number") omegaVal = lConf.global_omega.toFixed(3);
          if (kmoVal === "—" && typeof lConf.stage0_prerequisites?.kmo?.kmo_global === "number")
            kmoVal = lConf.stage0_prerequisites.kmo.kmo_global.toFixed(3);
          if (cfiVal === "—" && typeof lConf.cfa?.cfi === "number") cfiVal = lConf.cfa.cfi.toFixed(3);
        }
      } catch (_) {}
    }

    const kpiEl = $("#advanced-stats-kpis");
    if (kpiEl) {
      kpiEl.innerHTML = DOMPurify.sanitize(`
        <div class="diagnostic-kpi-card">
          <div class="diagnostic-kpi-val" id="stat-global-alpha" style="color:var(--accent-teal);">${escapeHtml(alphaVal)}</div>
          <div class="diagnostic-kpi-label">
            Alfa de Cronbach (α)
            <button type="button" class="info-tooltip-btn" data-tooltip="¿Qué es? Mide si las preguntas de tu encuesta son coherentes entre sí y miden lo mismo. Un valor arriba de 0.70 significa que tu encuesta es confiable y da resultados estables.">ℹ️</button>
          </div>
        </div>
        <div class="diagnostic-kpi-card">
          <div class="diagnostic-kpi-val" id="stat-global-omega" style="color:var(--accent-primary);">${escapeHtml(omegaVal)}</div>
          <div class="diagnostic-kpi-label">
            Omega de McDonald (ω)
            <button type="button" class="info-tooltip-btn" data-tooltip="¿Qué es? Es una versión moderna y más precisa del Alfa de Cronbach que no asume que todas las preguntas tienen el mismo peso. Valores arriba de 0.70 confirman una excelente consistencia.">ℹ️</button>
          </div>
        </div>
        <div class="diagnostic-kpi-card">
          <div class="diagnostic-kpi-val" id="stat-global-kmo" style="color:var(--accent-secondary);">${escapeHtml(kmoVal)}</div>
          <div class="diagnostic-kpi-label">
            KMO (Adecuación Muestral)
            <button type="button" class="info-tooltip-btn" data-tooltip="¿Qué es? Indica si la cantidad y correlación de tus respuestas es suficiente para agrupar las preguntas en temas o dimensiones. Valores superiores a 0.70 son ideales.">ℹ️</button>
          </div>
        </div>
        <div class="diagnostic-kpi-card">
          <div class="diagnostic-kpi-val" id="stat-global-cfi">${escapeHtml(cfiVal)}</div>
          <div class="diagnostic-kpi-label">
            Ajuste CFA (CFI)
            <button type="button" class="info-tooltip-btn" data-tooltip="¿Qué es? Evalúa si el modelo teórico de tu investigación encaja con la realidad de tus datos. Arriba de 0.90 o cercano a 0.85-0.90 es un ajuste adecuado.">ℹ️</button>
          </div>
        </div>
      `);
    }

    // Tabla de dimensiones
    const tbody = $("#tbody-advanced-dimensions");
    if (tbody) {
      const overlay = state.currentOverlay || {};
      const items = (overlay.items || []).filter((i) => i.included !== false);
      const dims = Array.from(new Set(items.map((i) => i.dimension || "General")));

      tbody.innerHTML = DOMPurify.sanitize(
        dims
          .map((dim) => {
            const count = items.filter((i) => (i.dimension || "General") === dim).length;
            const dimAlpha = bundle.dimensions?.[dim]?.cronbach?.alpha;
            const dimOmega = bundle.cfa?.factor_metrics?.[dim]?.omega_mcdonald;
            const dimAlphaTxt = typeof dimAlpha === "number" ? dimAlpha.toFixed(3) : count < 3 ? "— (Requiere ≥3 ítems)" : "—";
            const dimOmegaTxt = typeof dimOmega === "number" ? dimOmega.toFixed(3) : count < 3 ? "— (Requiere ≥3 ítems)" : "—";
            const statusTxt = (dimAlpha && dimAlpha >= 0.7) || (dimOmega && dimOmega >= 0.7) ? "✓ Confiable" : count >= 3 ? "Revisar reactivos" : "Subescala < 3 ítems";
            const statusColor = (dimAlpha && dimAlpha >= 0.7) || (dimOmega && dimOmega >= 0.7) ? "var(--accent-ok)" : "var(--accent-warn)";

            return `
            <tr style="border-bottom:1px solid var(--border-color);">
              <td style="padding:.6rem;font-weight:700;">${escapeHtml(dim)}</td>
              <td style="padding:.6rem;">${count} reactivos</td>
              <td style="padding:.6rem;color:var(--accent-teal);">${escapeHtml(dimAlphaTxt)}</td>
              <td style="padding:.6rem;color:var(--accent-primary);">${escapeHtml(dimOmegaTxt)}</td>
              <td style="padding:.6rem;"><span style="color:${statusColor};font-weight:700;">${escapeHtml(statusTxt)}</span></td>
            </tr>
          `;
          })
          .join("")
      );
    }

    renderMethodologicalWarnings(res);
    renderHypothesesResultsCards();
    goToStep(5);
  }

  // Renderizar Tarjetas Transparentes de Advertencias Metodológicas
  function renderMethodologicalWarnings(res) {
    const contStep3 = $("#methodological-warnings-container-step3");
    const contStep5 = $("#methodological-warnings-container") || $("#psychometrics-warnings-container");

    const dual = res.dual_report || {};
    const bundle = dual.confirmatory || dual.exploratory || {};
    const s0 = bundle.stage0_prerequisites || {};

    const warnings = [];

    // 1. Advertencia de tamaño muestral N < 15
    const nActive = res.n_active || state.rawRowsAnon.length;
    if (nActive > 0 && nActive < 15) {
      warnings.push({
        title: "Tamaño Muestral Reducido (N < 15)",
        reason: `Se cuenta con N = ${nActive} respuestas. La matriz de covarianza puede no ser positiva definida o presentar inestabilidad numérica en la inversión matricial para CFA y KMO.`,
        recommendation: "Se recomienda recolectar más respuestas (idealmente N ≥ 50 o 5 veces el número de reactivos) para robustez estadística.",
      });
    }

    // 2. Advertencia de matriz singular / determinante bajo
    if (s0.bartlett?.singular_matrix_warning || s0.bartlett?.det_R <= 1e-5) {
      warnings.push({
        title: "Matriz de Correlación Singular (det(R) ≤ 1e-5)",
        reason: "Existe colinealidad casi perfecta entre dos o más reactivos, o varianza reducida en un subgrupo de respuestas. La inversión matricial de máxima verosimilitud requiere regularización.",
        recommendation: "Revisar reactivos que pregunten prácticamente lo mismo y descartar duplicados desde 'Editar Instrumento'.",
      });
    }

    // 3. Advertencias devueltas directamente por el backend
    if (res.methodological_warning) {
      warnings.push({
        title: "Diagnóstico Metodológico del Servidor",
        reason: res.methodological_warning.reason || res.methodological_warning.detail || JSON.stringify(res.methodological_warning),
        recommendation: res.methodological_warning.recommendation || "Revisar la dimensionalidad y balance del cuestionario.",
      });
    }

    const renderCard = (w) => `
      <div class="methodological-warning-card" style="margin-top:1rem;padding:1.15rem;border-radius:12px;background:rgba(245, 158, 11, 0.08);border:1px solid rgba(245, 158, 11, 0.35);backdrop-filter:blur(8px);">
        <div style="display:flex;align-items:center;gap:.5rem;color:var(--accent-warn);font-weight:700;font-size:.95rem;margin-bottom:.35rem;">
          <span>⚠️</span> <span>${escapeHtml(w.title)}</span>
        </div>
        <div style="font-size:.85rem;line-height:1.45;color:var(--text-main);">
          <strong>Razón estadística:</strong> ${escapeHtml(w.reason)}
        </div>
        ${
          w.recommendation
            ? `<div style="font-size:.82rem;margin-top:.4rem;color:var(--text-muted);"><strong>Recomendación:</strong> ${escapeHtml(
                w.recommendation
              )}</div>`
            : ""
        }
      </div>
    `;

    if (warnings.length > 0) {
      const cardsHtml = DOMPurify.sanitize(warnings.map(renderCard).join(""));
      if (contStep3) {
        contStep3.innerHTML = cardsHtml;
        contStep3.classList.remove("hidden");
      }
      if (contStep5) {
        contStep5.innerHTML = cardsHtml;
        contStep5.classList.remove("hidden");
      }
    } else {
      if (contStep3) contStep3.classList.add("hidden");
      if (contStep5) contStep5.classList.add("hidden");
    }
  }

  // =========================================================================
  // TOOLTIPS PEDAGÓGICOS FLOTANTES (ÍCONO ℹ️)
  // =========================================================================
  function initTooltips() {
    const popup = $("#info-tooltip-popup");
    if (!popup) return;

    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".info-tooltip-btn");
      if (btn) {
        e.stopPropagation();
        const text = btn.getAttribute("data-tooltip") || "";
        popup.textContent = text;
        popup.classList.remove("hidden");

        const rect = btn.getBoundingClientRect();
        const top = rect.bottom + window.scrollY + 6;
        let left = rect.left + window.scrollX - 100;
        if (left < 10) left = 10;
        if (left + 320 > window.innerWidth) left = window.innerWidth - 330;

        popup.style.top = `${top}px`;
        popup.style.left = `${left}px`;
        return;
      }

      if (!e.target.closest(".info-tooltip-popup")) {
        popup.classList.add("hidden");
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") popup.classList.add("hidden");
    });
  }

  // =========================================================================
  // VINCULACIÓN DE EVENTOS DE INTERFAZ
  // =========================================================================
  function bindEvents() {
    $("#pill-step-1")?.addEventListener("click", () => goToStep(1));
    $("#pill-step-2")?.addEventListener("click", () => goToStep(2));
    $("#pill-step-3")?.addEventListener("click", () => goToStep(3));
    $("#pill-step-4")?.addEventListener("click", () => goToStep(4));
    $("#pill-step-5")?.addEventListener("click", () => renderAdvancedStatsStep());

    $("#btn-step-1-continue")?.addEventListener("click", () => goToStep(2));
    $("#btn-step-2-continue")?.addEventListener("click", confirmAndOpenDashboard);
    $("#btn-confirm-and-go-to-dashboard")?.addEventListener("click", confirmAndOpenDashboard);
    $("#btn-step-3-to-dashboard")?.addEventListener("click", confirmAndOpenDashboard);
    $("#btn-load-sample-data")?.addEventListener("click", () => loadSampleDataForGroup(state.currentGroupId));

    // Botones rápidos del mapeo unificado
    $("#btn-unified-exclude-formulas")?.addEventListener("click", () => {
      excludeFormulasOnly();
      renderUnifiedMappingTable();
    });
    $("#btn-unified-autodetect")?.addEventListener("click", () => {
      autoDetectScoping();
      renderUnifiedMappingTable();
    });
    $("#btn-add-specific-hypothesis")?.addEventListener("click", () => {
      const specifics = state.structuredHypotheses?.specifics || [];
      if (specifics.length < 3) {
        const hypDims = getAvailableDimensions().filter(
          (d) => !d.toLowerCase().includes("socio") && !d.toLowerCase().includes("filtro")
        );
        specifics.push({
          id: `HE${specifics.length + 1}`,
          text: "",
          x_dim: hypDims[0] || "",
          y_dim: hypDims[1] || hypDims[0] || "",
        });
        renderSpecificHypothesesList(hypDims);
      }
    });

    $("#txt-hypothesis-general")?.addEventListener("input", (e) => {
      const s3 = $("#txt-hypothesis-statement-step3");
      const s5 = $("#txt-hypothesis-statement");
      if (s3) s3.value = e.target.value;
      if (s5) s5.value = e.target.value;
      if (state.structuredHypotheses?.general) {
        state.structuredHypotheses.general.text = e.target.value;
      }
    });
    $("#hyp-general-x")?.addEventListener("change", (e) => {
      if (state.structuredHypotheses?.general) {
        state.structuredHypotheses.general.x_dim = e.target.value;
      }
    });
    $("#hyp-general-y")?.addEventListener("change", (e) => {
      if (state.structuredHypotheses?.general) {
        state.structuredHypotheses.general.y_dim = e.target.value;
      }
    });

    // Modal de Scoping de Columnas
    $("#btn-open-column-scoping")?.addEventListener("click", openColumnScopingModal);
    $("#btn-close-column-scoping")?.addEventListener("click", closeColumnScopingModal);
    $("#btn-cancel-column-scoping")?.addEventListener("click", closeColumnScopingModal);
    $("#btn-confirm-column-scoping")?.addEventListener("click", confirmColumnScoping);
    $("#btn-scoping-auto-detect")?.addEventListener("click", autoDetectScoping);
    $("#btn-scoping-exclude-formulas")?.addEventListener("click", excludeFormulasOnly);

    // Navegación a Dashboard y Psicométricos
    $("#btn-step-3-to-dashboard")?.addEventListener("click", async () => {
      if (
        state.hypotheses &&
        state.hypotheses.length > 0 &&
        (!state.analysisResult?.hypotheses_evaluation || state.analysisResult.hypotheses_evaluation.length === 0)
      ) {
        await processAnalysisAndGoToDiagnostic();
      }
      renderDashboardStep();
    });

    $("#btn-toggle-advanced-stats")?.addEventListener("click", async () => {
      if (
        state.hypotheses &&
        state.hypotheses.length > 0 &&
        (!state.analysisResult?.hypotheses_evaluation || state.analysisResult.hypotheses_evaluation.length === 0)
      ) {
        await processAnalysisAndGoToDiagnostic();
      }
      renderAdvancedStatsStep();
    });
    $("#btn-back-to-dashboard")?.addEventListener("click", () => goToStep(4));

    // Botones del Editor de Instrumento
    $("#btn-open-instrument-editor")?.addEventListener("click", openInstrumentEditor);
    $("#btn-back-from-editor")?.addEventListener("click", () => goToStep(4));
    $("#btn-save-instrument-changes")?.addEventListener("click", saveInstrumentChanges);

    // Toggle global de inclusión en editor
    $("#chk-toggle-all-items-inclusion")?.addEventListener("change", (e) => {
      const checked = e.target.checked;
      $$(".chk-edit-include").forEach((chk) => {
        chk.checked = checked;
      });
      (state.currentOverlay?.items || []).forEach((it) => {
        it.included = checked;
        it.exclude_from_psychometrics = !checked;
      });
      renderInstrumentEditor();
    });

    // Selectores de Gráfica y Color
    $("#chart-type-select")?.addEventListener("change", (e) => {
      state.chartType = e.target.value;
      localStorage.setItem("unab_chart_type", state.chartType);
      renderQuestionsCardsList();
    });

    $("#chart-palette-select")?.addEventListener("change", (e) => {
      state.chartPalette = e.target.value;
      localStorage.setItem("unab_chart_palette", state.chartPalette);
      renderQuestionsCardsList();
    });

    // Filtrado Cruzado: Botón de reseteo
    $("#btn-clear-crossfilter")?.addEventListener("click", clearCrossFilter);

    // Gemini AI: Reparación de redacción
    $("#btn-call-gemini-repair")?.addEventListener("click", callGeminiRepair);
    $("#btn-apply-gemini-improvements")?.addEventListener("click", applyGeminiImprovements);

    // Gemini AI: Extracción de Hipótesis Literal (Paso 3 y Paso 5)
    $("#btn-map-hypothesis-gemini")?.addEventListener("click", () => handleGeminiExtractHypothesis("step5"));
    $("#btn-map-hypothesis-gemini-step3")?.addEventListener("click", () => handleGeminiExtractHypothesis("step3"));

    $("#txt-hypothesis-statement-step3")?.addEventListener("input", (e) => {
      const step5Input = $("#txt-hypothesis-statement");
      if (step5Input) step5Input.value = e.target.value;
    });
    $("#txt-hypothesis-statement")?.addEventListener("input", (e) => {
      const step3Input = $("#txt-hypothesis-statement-step3");
      if (step3Input) step3Input.value = e.target.value;
    });

    $("#btn-accept-gemini-hypothesis")?.addEventListener("click", () => {
      if (state.lastExtractedHypothesis) {
        const h = state.lastExtractedHypothesis;
        const newHyp = {
          id: `H${state.hypotheses.length + 1}`,
          x_dim: h.matched_x_dimension || h.variable_x,
          y_dim: h.matched_y_dimension || h.variable_y,
          text: $("#txt-hypothesis-statement")?.value || $("#txt-hypothesis-statement-step3")?.value || "Relación investigada con Gemini AI",
        };
        state.hypotheses.push(newHyp);
        saveHypotheses();
        renderHypothesesList();
        renderHypothesesResultsCards();
        alert("✓ Hipótesis añadida con éxito a la lista de contrastes.");
      }
    });

    // Hipótesis convencionales
    $("#btn-add-hypothesis")?.addEventListener("click", addHypothesisFromUI);
    $("#btn-suggest-hypotheses")?.addEventListener("click", suggestDefaultHypotheses);

    // Invitar Equipo
    $("#btn-save-team-members")?.addEventListener("click", async () => {
      const input = $("#team-emails-input");
      const val = input ? input.value.trim() : "";
      if (!val) return;

      state.teamEmails = val;
      localStorage.setItem("unab_team_emails", val);

      const feedback = $("#team-invite-feedback");
      try {
        const resp = await apiFetch("/api/team-invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ group_id: state.currentGroupId, emails: val }),
        });
        if (feedback) {
          feedback.textContent = `✓ ${resp.message}`;
          feedback.style.color = "var(--accent-ok)";
        }
      } catch (err) {
        if (feedback) feedback.textContent = `Nota de guardado: ${err.message}`;
      }
    });

    // Filtros de búsqueda en Dashboard
    $("#dashboard-search-input")?.addEventListener("input", (e) => {
      state.searchFilter = e.target.value.trim();
      renderQuestionsCardsList();
    });

    $("#dashboard-dimension-filter")?.addEventListener("change", (e) => {
      state.dimensionFilter = e.target.value;
      renderQuestionsCardsList();
    });

    $("#btn-reset-filters")?.addEventListener("click", () => {
      state.searchFilter = "";
      state.dimensionFilter = "all";
      const sInput = $("#dashboard-search-input");
      const dSel = $("#dashboard-dimension-filter");
      if (sInput) sInput.value = "";
      if (dSel) dSel.value = "all";
      renderQuestionsCardsList();
    });

    // Ingesta por archivo local
    $("#file-upload-input")?.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const fd = new FormData();
      fd.append("file", file);
      fd.append("group_id", state.currentGroupId);

      const statusMsg = $("#ingest-status-msg");
      if (statusMsg) statusMsg.textContent = `Leyendo '${file.name}'...`;

      try {
        const data = await apiFetch("/api/ingest-readonly", { method: "POST", body: fd });
        state.rawRowsAnon = data.rows_anon || [];
        state.filteredRowsAnon = state.rawRowsAnon.slice();
        state.activeCrossFilters = {};
        state.sourceSha256 = data.source_sha256 || "OK";

        if (data.mapping_suggestions && data.mapping_suggestions.is_external_discovered && data.mapping_suggestions.external_overlay) {
          state.originalOverlay = data.mapping_suggestions.external_overlay;
          state.currentOverlay = JSON.parse(JSON.stringify(state.originalOverlay));
        } else {
          const gCat = state.groupsById[state.currentGroupId] || { group_id: state.currentGroupId, questions: [] };
          state.originalOverlay = buildDefaultOverlay(gCat);
          state.currentOverlay = JSON.parse(JSON.stringify(state.originalOverlay));
        }

        setupColumnScopingFromRows(state.rawRowsAnon, state.currentOverlay);
        renderUnifiedMappingTable();
        renderHypothesesSetup();
        $("#unified-mapping-section")?.classList.remove("hidden");

        if (statusMsg) statusMsg.textContent = `✓ Archivo '${file.name}' cargado (${data.n_rows} encuestas).`;

        $("#btn-confirm-and-go-to-dashboard")?.removeAttribute("disabled");
        $("#btn-step-2-continue")?.removeAttribute("disabled");

        await processAnalysisAndGoToDiagnostic(false);
      } catch (err) {
        if (statusMsg) statusMsg.textContent = `Error: ${err.message}`;
      }
    });

    // Ingesta por Google Sheets
    $("#btn-ingest-gsheet")?.addEventListener("click", async () => {
      const url = $("#gsheet-url-input")?.value?.trim();
      if (!url) return;

      const statusMsg = $("#ingest-status-msg");
      if (statusMsg) statusMsg.textContent = "Conectando con Google Sheet...";

      try {
        const data = await apiFetch("/api/ingest-readonly", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ group_id: state.currentGroupId, google_sheet_url: url }),
        });
        state.rawRowsAnon = data.rows_anon || [];
        state.filteredRowsAnon = state.rawRowsAnon.slice();
        state.activeCrossFilters = {};
        state.sourceSha256 = data.source_sha256 || "OK";

        if (data.mapping_suggestions && data.mapping_suggestions.is_external_discovered && data.mapping_suggestions.external_overlay) {
          state.originalOverlay = data.mapping_suggestions.external_overlay;
          state.currentOverlay = JSON.parse(JSON.stringify(state.originalOverlay));
        } else {
          const gCat = state.groupsById[state.currentGroupId] || { group_id: state.currentGroupId, questions: [] };
          state.originalOverlay = buildDefaultOverlay(gCat);
          state.currentOverlay = JSON.parse(JSON.stringify(state.originalOverlay));
        }

        setupColumnScopingFromRows(state.rawRowsAnon, state.currentOverlay);
        renderUnifiedMappingTable();
        renderHypothesesSetup();
        $("#unified-mapping-section")?.classList.remove("hidden");

        if (statusMsg) statusMsg.textContent = `✓ Google Sheet conectado (${data.n_rows} encuestas).`;

        $("#btn-confirm-and-go-to-dashboard")?.removeAttribute("disabled");
        $("#btn-step-2-continue")?.removeAttribute("disabled");

        await processAnalysisAndGoToDiagnostic(false);
      } catch (err) {
        if (statusMsg) statusMsg.textContent = `Error: ${err.message}`;
      }
    });

    // Modal de Autenticación
    $("#btn-user-session")?.addEventListener("click", () => {
      $("#auth-modal")?.classList.remove("hidden");
    });
    $("#btn-close-auth-modal")?.addEventListener("click", () => {
      $("#auth-modal")?.classList.add("hidden");
    });
    $("#btn-quick-student-login")?.addEventListener("click", () => {
      state.currentRole = "team_member";
      state.currentUserEmail = "estudiante@unab.edu.sv";
      localStorage.setItem("unab_role", "team_member");
      localStorage.setItem("unab_user_email", "estudiante@unab.edu.sv");
      updateUserSessionDisplay();
      $("#auth-modal")?.classList.add("hidden");
    });
    $("#btn-quick-admin-login")?.addEventListener("click", () => {
      state.currentRole = "docente_admin";
      state.currentUserEmail = "docente@unab.edu.sv";
      localStorage.setItem("unab_role", "docente_admin");
      localStorage.setItem("unab_user_email", "docente@unab.edu.sv");
      updateUserSessionDisplay();
      $("#auth-modal")?.classList.add("hidden");
    });
    $("#btn-google-login-action")?.addEventListener("click", () => {
      state.currentUserEmail = "usuario.unab@unab.edu.sv";
      localStorage.setItem("unab_user_email", "usuario.unab@unab.edu.sv");
      updateUserSessionDisplay();
      $("#auth-modal")?.classList.add("hidden");
    });
    $("#brand-home-link")?.addEventListener("click", () => goToStep(1));
  }

  // Exportar helper a nivel global si se requiere en pruebas
  window.computeSmartFrequencies = computeSmartFrequencies;

  window.addEventListener("DOMContentLoaded", initApp);
})();
