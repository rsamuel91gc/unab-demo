/**
 * PsychometricsEngine.js - Motor Estadístico y Psicométrico Polimórfico Universal (Browser / Node / Cloudflare / GAS)
 * Paridad matemática exacta (< 1e-4) con backend/psychometrics_engine.py y Oráculo R (psych, lavaan, semTools).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PsychometricsEngine = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MIN_ITEMS_PER_FACTOR = 3;
  const FLOOR_CEILING_THRESHOLD = 0.15;
  const HTMT_STRICT_THRESHOLD = 0.85;
  const Z_95 = 1.959963984540054;

  const PII_COLUMN_REGEX = /(correo|e[-_]?mail|nombre|apellido|carn[eé]|dui|nit|tel[eé]fono|celular|ip_address|direcci[oó]n)/i;
  const EMAIL_REGEX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

  const SPANISH_TEXT_MAP = {
    "totalmente en desacuerdo": 1.0, "muy en desacuerdo": 1.0, "nunca": 1.0, "muy bajo": 1.0, "muy bajos": 1.0, "nada": 1.0,
    "en desacuerdo": 2.0, "casi nunca": 2.0, "raramente": 2.0, "bajo": 2.0, "poco": 2.0,
    "ni de acuerdo ni en desacuerdo": 3.0, "neutral": 3.0, "a veces": 3.0, "algunas veces": 3.0, "moderado": 3.0, "moderadamente": 3.0,
    "de acuerdo": 4.0, "casi siempre": 4.0, "frecuentemente": 4.0, "a menudo": 4.0, "alto": 4.0, "mucho": 4.0,
    "totalmente de acuerdo": 5.0, "muy de acuerdo": 5.0, "siempre": 5.0, "muy alto": 5.0, "muy altos": 5.0, "completamente": 5.0,
  };

  function roundTo(val, digits) {
    if (!Number.isFinite(val)) return 0.0;
    const factor = Math.pow(10, digits);
    return Math.round((val + Number.EPSILON) * factor) / factor;
  }

  function cloneJson(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function isFiniteNum(v) {
    return typeof v === "number" && Number.isFinite(v);
  }

  // =========================================================================
  // 1. FUNCIONES ESPECIALES EXACTAS (Gamma, Beta, Chi2, F, Student-t, ncx2)
  // =========================================================================

  function logGamma(z) {
    const p = [
      676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012,
      9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (z < 0.5) {
      return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    }
    z -= 1;
    let x = 0.99999999999980993;
    for (let i = 0; i < p.length; i++) {
      x += p[i] / (z + i + 1);
    }
    const t = z + p.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  function gammaSeriesP(a, x) {
    const gln = logGamma(a);
    let ap = a;
    let sum = 1.0 / a;
    let del = sum;
    for (let n = 1; n <= 400; n++) {
      ap += 1.0;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) {
        return sum * Math.exp(-x + a * Math.log(x) - gln);
      }
    }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }

  function gammaCfQ(a, x) {
    const gln = logGamma(a);
    let b = x + 1.0 - a;
    let c = 1.0 / 1e-30;
    let d = 1.0 / b;
    let h = d;
    for (let i = 1; i <= 400; i++) {
      const an = -i * (i - a);
      b += 2.0;
      d = an * d + b;
      if (Math.abs(d) < 1e-30) d = 1e-30;
      c = b + an / c;
      if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1.0 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1.0) < 1e-14) break;
    }
    return Math.exp(-x + a * Math.log(x) - gln) * h;
  }

  function gammaP(a, x) {
    if (x <= 0) return 0.0;
    if (a <= 0) return 1.0;
    if (x < a + 1.0) return Math.min(1.0, Math.max(0.0, gammaSeriesP(a, x)));
    return Math.min(1.0, Math.max(0.0, 1.0 - gammaCfQ(a, x)));
  }

  function gammaQ(a, x) {
    if (x <= 0) return 1.0;
    if (a <= 0) return 0.0;
    if (x < a + 1.0) return Math.min(1.0, Math.max(0.0, 1.0 - gammaSeriesP(a, x)));
    return Math.min(1.0, Math.max(0.0, gammaCfQ(a, x)));
  }

  function normSf(z) {
    // Upper tail P(Z > z)
    if (z === 0) return 0.5;
    const erfAbs = gammaP(0.5, 0.5 * z * z);
    return z >= 0 ? 0.5 * (1.0 - erfAbs) : 0.5 * (1.0 + erfAbs);
  }

  function chi2Sf(x, df) {
    if (x <= 0 || df <= 0) return 1.0;
    return gammaQ(0.5 * df, 0.5 * x);
  }

  function chi2Cdf(x, df) {
    if (x <= 0 || df <= 0) return 0.0;
    return gammaP(0.5 * df, 0.5 * x);
  }

  function chi2Ppf(p, df) {
    if (p <= 0) return 0.0;
    if (p >= 1) return Infinity;
    let lo = 0.0;
    let hi = Math.max(df * 5.0, 100.0);
    while (chi2Cdf(hi, df) < p && hi < 1e8) hi *= 2.0;
    for (let it = 0; it < 70; it++) {
      const mid = 0.5 * (lo + hi);
      if (chi2Cdf(mid, df) < p) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  function ncx2Cdf(x, df, ncp) {
    if (x <= 0) return 0.0;
    if (ncp <= 1e-14) return chi2Cdf(x, df);
    const halfLam = 0.5 * ncp;
    const logHalfLam = Math.log(halfLam);
    const kMode = Math.floor(halfLam);
    let total = 0.0;

    // Sumar hacia arriba y hacia abajo alrededor de la moda en espacio log para evitar underflow
    for (let dir = -1; dir <= 1; dir += 2) {
      let k = dir === 1 ? kMode : kMode - 1;
      while (k >= 0) {
        const logW = -halfLam + k * logHalfLam - logGamma(k + 1);
        const w = logW > -700 ? Math.exp(logW) : 0.0;
        const term = w * chi2Cdf(x, df + 2 * k);
        total += term;
        if (w < 1e-15 && k !== kMode) break;
        k += dir;
        if (k > kMode + 800) break;
      }
    }
    return Math.min(1.0, Math.max(0.0, total));
  }

  function betacf(a, b, x) {
    const MAXIT = 300;
    const EPS = 1e-14;
    const FPMIN = 1e-30;
    const qab = a + b;
    const qap = a + 1.0;
    const qam = a - 1.0;
    let c = 1.0;
    let d = 1.0 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1.0 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1.0 + aa * d;
      if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1.0 + aa / c;
      if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1.0 / d;
      h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1.0 + aa * d;
      if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1.0 + aa / c;
      if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1.0 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1.0) < EPS) break;
    }
    return h;
  }

  function betainc(a, b, x) {
    if (x <= 0.0) return 0.0;
    if (x >= 1.0) return 1.0;
    const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1.0 - x));
    if (x < (a + 1.0) / (a + b + 2.0)) {
      return bt * betacf(a, b, x) / a;
    }
    return 1.0 - bt * betacf(b, a, 1.0 - x) / b;
  }

  function fCdf(fVal, d1, d2) {
    if (fVal <= 0) return 0.0;
    const u = (d1 * fVal) / (d1 * fVal + d2);
    return betainc(0.5 * d1, 0.5 * d2, u);
  }

  function fPpf(prob, d1, d2) {
    if (prob <= 0) return 0.0;
    if (prob >= 1) return Infinity;
    let lo = 0.0;
    let hi = 100.0;
    while (fCdf(hi, d1, d2) < prob && hi < 1e8) hi *= 2.0;
    for (let it = 0; it < 75; it++) {
      const mid = 0.5 * (lo + hi);
      if (fCdf(mid, d1, d2) < prob) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  function tPvalue(tAbs, df) {
    if (!Number.isFinite(tAbs) || df <= 0) return 1.0;
    if (tAbs === 0) return 1.0;
    return Math.min(1.0, Math.max(0.0, betainc(0.5 * df, 0.5, df / (df + tAbs * tAbs))));
  }

  // =========================================================================
  // 2. ÁLGEBRA LINEAL (Matrices, LU con pivoteo, Inversa, Eigenvalores)
  // =========================================================================

  function matTranspose(A) {
    const r = A.length;
    const c = A[0].length;
    const out = Array.from({ length: c }, () => new Array(r).fill(0));
    for (let i = 0; i < r; i++) {
      for (let j = 0; j < c; j++) out[j][i] = A[i][j];
    }
    return out;
  }

  function matMul(A, B) {
    const r = A.length;
    const k = A[0].length;
    const c = B[0].length;
    const out = Array.from({ length: r }, () => new Array(c).fill(0));
    for (let i = 0; i < r; i++) {
      for (let j = 0; j < c; j++) {
        let s = 0;
        for (let m = 0; m < k; m++) s += A[i][m] * B[m][j];
        out[i][j] = s;
      }
    }
    return out;
  }

  function luDecomposeAndSolve(A, B = null) {
    const n = A.length;
    const M = A.map((row) => row.slice());
    let permSign = 1;
    const perm = Array.from({ length: n }, (_, i) => i);

    for (let k = 0; k < n; k++) {
      let maxVal = Math.abs(M[k][k]);
      let piv = k;
      for (let i = k + 1; i < n; i++) {
        const av = Math.abs(M[i][k]);
        if (av > maxVal) {
          maxVal = av;
          piv = i;
        }
      }
      if (maxVal < 1e-15) {
        return { singular: true, sign: 0, logDet: -Infinity, inv: null, solved: null };
      }
      if (piv !== k) {
        const tmp = M[k]; M[k] = M[piv]; M[piv] = tmp;
        const tp = perm[k]; perm[k] = perm[piv]; perm[piv] = tp;
        permSign = -permSign;
      }
      for (let i = k + 1; i < n; i++) {
        M[i][k] /= M[k][k];
        const mult = M[i][k];
        for (let j = k + 1; j < n; j++) {
          M[i][j] -= mult * M[k][j];
        }
      }
    }

    let sign = permSign;
    let logDet = 0.0;
    for (let i = 0; i < n; i++) {
      if (M[i][i] < 0) sign = -sign;
      else if (M[i][i] === 0) return { singular: true, sign: 0, logDet: -Infinity, inv: null, solved: null };
      logDet += Math.log(Math.abs(M[i][i]));
    }

    function solveCols(RHS) {
      const mCols = RHS[0].length;
      const X = Array.from({ length: n }, () => new Array(mCols).fill(0));
      for (let col = 0; col < mCols; col++) {
        const y = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
          let sum = RHS[perm[i]][col];
          for (let j = 0; j < i; j++) sum -= M[i][j] * y[j];
          y[i] = sum;
        }
        for (let i = n - 1; i >= 0; i--) {
          let sum = y[i];
          for (let j = i + 1; j < n; j++) sum -= M[i][j] * X[j][col];
          X[i][col] = sum / M[i][i];
        }
      }
      return X;
    }

    let solved = null;
    if (B !== null) {
      solved = solveCols(B);
    }
    return { singular: false, sign, logDet, solveCols, solved };
  }

  function invertMatrix(A) {
    const n = A.length;
    const lu = luDecomposeAndSolve(A);
    if (lu.singular) return null;
    const I = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? 1 : 0)));
    return lu.solveCols(I);
  }

  function jacobiMinEigenvalue(S) {
    const n = S.length;
    if (n === 0) return 0;
    if (n === 1) return S[0][0];
    const A = S.map((r) => r.slice());
    for (let sweep = 0; sweep < 40; sweep++) {
      let maxOff = 0;
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          const apq = Math.abs(A[p][q]);
          if (apq > maxOff) maxOff = apq;
          if (apq > 1e-13) {
            const tau = (A[q][q] - A[p][p]) / (2.0 * A[p][q]);
            const t = tau >= 0 ? 1.0 / (tau + Math.sqrt(1.0 + tau * tau)) : -1.0 / (-tau + Math.sqrt(1.0 + tau * tau));
            const c = 1.0 / Math.sqrt(1.0 + t * t);
            const s = t * c;
            const app = A[p][p];
            const aqq = A[q][q];
            A[p][p] = app - t * A[p][q];
            A[q][q] = aqq + t * A[p][q];
            A[p][q] = 0.0;
            A[q][p] = 0.0;
            for (let r = 0; r < n; r++) {
              if (r !== p && r !== q) {
                const arp = A[r][p];
                const arq = A[r][q];
                A[r][p] = c * arp - s * arq;
                A[p][r] = A[r][p];
                A[r][q] = s * arp + c * arq;
                A[q][r] = A[r][q];
              }
            }
          }
        }
      }
      if (maxOff < 1e-12) break;
    }
    let minEig = A[0][0];
    for (let i = 1; i < n; i++) if (A[i][i] < minEig) minEig = A[i][i];
    return minEig;
  }

  // =========================================================================
  // 3. SCRUBBING PII & NORMALIZACIÓN DE FECHAS + OVERLAY TRANSFORMER
  // =========================================================================

  function scrubPiiRows(rows) {
    if (!rows || !rows.length) return [[], []];
    const allCols = Object.keys(rows[0]);
    const piiCols = new Set();

    for (const col of allCols) {
      if (PII_COLUMN_REGEX.test(String(col))) {
        piiCols.add(col);
        continue;
      }
      const sampleVals = [];
      for (let i = 0; i < Math.min(15, rows.length); i++) {
        const v = rows[i][col];
        if (v !== null && v !== undefined && String(v).trim() !== "") {
          sampleVals.push(String(v).trim());
        }
      }
      if (sampleVals.length > 0) {
        const emailCount = sampleVals.filter((v) => EMAIL_REGEX.test(v)).length;
        if (emailCount >= Math.max(1, Math.floor(sampleVals.length / 2))) {
          piiCols.add(col);
        }
      }
    }

    const cleaned = rows.map((row) => {
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        if (!piiCols.has(k)) out[k] = v;
      }
      return out;
    });
    return [cleaned, Array.from(piiCols).sort()];
  }

  function _pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function parseAndNormalizeDate(rawVal) {
    if (rawVal === null || rawVal === undefined) return null;
    const s = String(rawVal).trim();
    if (!s || ["nan", "none", "null", "na", "invalid date"].includes(s.toLowerCase())) return null;

    // 1. Serial numérico de Excel
    if (/^\d+(\.\d+)?$/.test(s)) {
      const num = parseFloat(s);
      if (num >= 20000 && num <= 90000) {
        const baseMs = Date.UTC(1899, 11, 30);
        const dt = new Date(baseMs + num * 86400000);
        return `${_pad2(dt.getUTCDate())}/${_pad2(dt.getUTCMonth() + 1)}/${dt.getUTCFullYear()} ${_pad2(dt.getUTCHours())}:${_pad2(dt.getUTCMinutes())}`;
      }
    }

    // 2. ISO-8601 (YYYY-MM-DDTHH:mm(:ss)?(Z|+00:00)?)
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i);
    if (m) {
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const d = parseInt(m[3], 10);
      const hh = m[4] ? parseInt(m[4], 10) : 0;
      const mm = m[5] ? parseInt(m[5], 10) : 0;
      return `${_pad2(d)}/${_pad2(mo)}/${y} ${_pad2(hh)}:${_pad2(mm)}`;
    }

    // 3. DD/MM/YYYY o DD-MM-YYYY o MM/DD/YYYY con hora opcional
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      const y = parseInt(m[3], 10);
      const hh = m[4] ? parseInt(m[4], 10) : 0;
      const mm = m[5] ? parseInt(m[5], 10) : 0;
      // Si a > 12 es DD/MM; si b > 12 asumimos MM/DD; si ambos <= 12 preferimos DD/MM (estándar Forms Latam)
      let d = a;
      let mo = b;
      if (a <= 12 && b > 12) {
        mo = a;
        d = b;
      }
      return `${_pad2(d)}/${_pad2(mo)}/${y} ${_pad2(hh)}:${_pad2(mm)}`;
    }

    // 4. "Nov 14, 2026" (Jotform inglés)
    const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    m = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (m && MONTHS[m[1].toLowerCase()]) {
      const mo = MONTHS[m[1].toLowerCase()];
      const d = parseInt(m[2], 10);
      const y = parseInt(m[3], 10);
      const hh = m[4] ? parseInt(m[4], 10) : 0;
      const mm = m[5] ? parseInt(m[5], 10) : 0;
      return `${_pad2(d)}/${_pad2(mo)}/${y} ${_pad2(hh)}:${_pad2(mm)}`;
    }

    return null;
  }

  function _parseNumericLikert(rawVal, categoryMap, scaleMin = 1, scaleMax = 5) {
    if (rawVal === null || rawVal === undefined) return null;
    if (typeof rawVal === "number") return Number.isFinite(rawVal) ? rawVal : null;
    const s = String(rawVal).trim();
    if (!s || ["nan", "none", "null", "na", "no sé / no aplica", "no aplica"].includes(s.toLowerCase())) return null;
    if (categoryMap && Object.prototype.hasOwnProperty.call(categoryMap, s)) {
      return Number(categoryMap[s]);
    }
    const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*(?:[=.\-:]|\s|$)/);
    if (m) {
      const val = parseFloat(m[1]);
      if (val >= scaleMin && val <= scaleMax) return val;
    }
    const low = s.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(SPANISH_TEXT_MAP, low)) {
      return Math.min(scaleMax, Math.max(scaleMin, SPANISH_TEXT_MAP[low]));
    }
    return null;
  }

  function _gradeBinary(rawVal, correctKey) {
    if (rawVal === null || rawVal === undefined) return null;
    if (typeof rawVal === "number" && (rawVal === 0 || rawVal === 1)) return rawVal;
    const s = String(rawVal).trim();
    if (!s || ["nan", "none", "null"].includes(s.toLowerCase())) return null;
    if (!correctKey) return null;
    const ck = String(correctKey).trim();
    if (s.toLowerCase() === ck.toLowerCase()) return 1;
    const mS = s.match(/^([a-eA-E])[).:\s]/);
    const mC = ck.match(/^([a-eA-E])[).:\s]/);
    if (mS && mC) return mS[1].toLowerCase() === mC[1].toLowerCase() ? 1 : 0;
    return 0;
  }

  function _getOverlayItems(overlay) {
    return (overlay && (overlay.items || overlay.questions)) || [];
  }

  function applyOverlayTransforms(rows, overlay) {
    const [cleanRows, scrubbedCols] = scrubPiiRows(rows || []);
    const items = _getOverlayItems(overlay);
    const colMapping = (overlay && overlay.column_mapping) || {};
    const catMapping = (overlay && overlay.category_mapping) || {};

    const itemToCol = {};
    for (const [rawCol, iid] of Object.entries(colMapping)) {
      itemToCol[iid] = rawCol;
    }

    let tsCol = null;
    if (cleanRows.length > 0) {
      for (const k of Object.keys(cleanRows[0])) {
        const lk = k.toLowerCase();
        if (lk.includes("timestamp") || lk.includes("marca temporal") || lk.includes("fecha") || lk.includes("submission date")) {
          tsCol = k;
          break;
        }
      }
    }

    const timestampsNorm = [];
    if (tsCol) {
      for (const r of cleanRows) {
        const nts = parseAndNormalizeDate(r[tsCol]);
        if (nts) timestampsNorm.push(nts);
      }
    }

    const causalTraces = [];
    if (tsCol) {
      causalTraces.push({
        variable_id: "VAR:Timestamp_Encuesta",
        source_column: tsCol,
        raw_type: "string/date",
        raw_sample_values: cleanRows.slice(0, 3).map((r) => r[tsCol]),
        transformation_id: "SYM:OverlayTransformer#parseAndNormalizeDate",
        transformation_rule: "Normalización ISO-8601 / Serial Excel / Local -> 'DD/MM/YYYY HH:mm'",
        transformed_sample_values: timestampsNorm.slice(0, 3),
        target_dom_selector: "#meta-date-range",
        oracle_status: timestampsNorm.every((x) => x !== null) ? "STAT_ORACLE_OK" : "PENDING",
        render_status: "PENDING",
      });
    }

    const transformedRows = cleanRows.map((_, idx) => {
      const base = { _row_index: idx };
      if (tsCol) base._timestamp_norm = parseAndNormalizeDate(cleanRows[idx][tsCol]);
      return base;
    });

    const likertItems = items.filter((it) => it.role === "LIKERT_REFLECTIVA");
    const scalesSet = new Set(likertItems.map((it) => `${it.scale_min || 1}_${it.scale_max || 5}`));
    const mixedScales = scalesSet.size > 1;

    const rawNumericCols = {};
    for (const it of items) {
      const iid = it.id;
      let srcCol = itemToCol[iid] || it.source_column || iid;
      if (cleanRows.length > 0 && !(srcCol in cleanRows[0]) && iid in cleanRows[0]) {
        srcCol = iid;
      }
      const role = it.role || "LIKERT_REFLECTIVA";
      const smin = Number(it.scale_min !== undefined && it.scale_min !== null ? it.scale_min : 1);
      const smax = Number(it.scale_max !== undefined && it.scale_max !== null ? it.scale_max : 5);
      const isRev = Boolean(it.is_reverse);
      const cmap = catMapping[iid] || it.category_map || {};

      const rawSamples = cleanRows.slice(0, 3).map((r) => r[srcCol]);
      const vals = [];
      let rule = "";
      let transId = "";

      if (role === "LIKERT_REFLECTIVA" || role === "ORDINAL_SINGLE_ITEM") {
        for (let i = 0; i < cleanRows.length; i++) {
          let v = _parseNumericLikert(cleanRows[i][srcCol], cmap, smin, smax);
          if (v !== null && isRev) v = (smax + smin) - v;
          vals.push(v);
          transformedRows[i][iid] = v;
          transformedRows[i][`${iid}_raw`] = cleanRows[i][srcCol];
        }
        rule = `Mapeo Likert [${smin}..${smax}]` + (isRev ? ` + Inversión (${smax + smin} - X)` : "");
        transId = isRev ? "SYM:OverlayTransformer#invertLikertScale" : "SYM:OverlayTransformer#mapLikertValue";
      } else if (role === "DICOTOMICA_CONOCIMIENTO" || role === "CONOCIMIENTO_DICOTOMICA") {
        const ckey = it.correct_key;
        for (let i = 0; i < cleanRows.length; i++) {
          const v = _gradeBinary(cleanRows[i][srcCol], ckey);
          const fv = v !== null ? Number(v) : null;
          vals.push(fv);
          transformedRows[i][iid] = fv;
          transformedRows[i][`${iid}_raw`] = cleanRows[i][srcCol];
        }
        rule = `Binarización 1/0 contra clave='${ckey}'`;
        transId = "SYM:OverlayTransformer#gradeBinaryItem";
      } else {
        for (let i = 0; i < cleanRows.length; i++) {
          const rv = cleanRows[i][srcCol];
          const sv = rv !== null && rv !== undefined && String(rv).trim() !== "" ? String(rv).trim() : null;
          transformedRows[i][iid] = sv;
          transformedRows[i][`${iid}_raw`] = rv;
          vals.push(sv);
        }
        rule = "Normalización categórica (trim) y aislamiento de matrices CFA/Alfa";
        transId = "SYM:OverlayTransformer#isolateNonReflective";
      }

      rawNumericCols[iid] = vals;
      causalTraces.push({
        variable_id: `VAR:${iid}`,
        source_column: srcCol,
        raw_type: it.scale_type || role,
        raw_sample_values: rawSamples,
        transformation_id: transId,
        transformation_rule: rule,
        transformed_sample_values: vals.slice(0, 3),
        target_dom_selector: `#card-item-${iid}`,
        oracle_status: "STAT_ORACLE_OK",
        render_status: "PENDING",
      });
    }

    if (mixedScales) {
      for (const it of likertItems) {
        const iid = it.id;
        const smin = Number(it.scale_min || 1);
        const smax = Number(it.scale_max || 5);
        const valid = rawNumericCols[iid].filter((v) => isFiniteNum(v));
        const mu = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0.0;
        let sd = 1.0;
        if (valid.length > 1) {
          const vsum = valid.reduce((acc, v) => acc + (v - mu) * (v - mu), 0);
          sd = Math.sqrt(vsum / (valid.length - 1)) || 1.0;
        }
        for (let i = 0; i < transformedRows.length; i++) {
          const val = transformedRows[i][iid];
          if (isFiniteNum(val)) {
            transformedRows[i][`${iid}_z`] = roundTo((val - mu) / sd, 6);
            transformedRows[i][`${iid}_pomp`] = roundTo(((val - smin) / Math.max(1.0, smax - smin)) * 100.0, 4);
          } else {
            transformedRows[i][`${iid}_z`] = null;
            transformedRows[i][`${iid}_pomp`] = null;
          }
        }
      }
    }

    return {
      rows: transformedRows,
      scrubbed_pii_columns: scrubbedCols,
      timestamps: timestampsNorm,
      mixed_scales_detected: mixedScales,
      causal_traces: causalTraces,
    };
  }

  // =========================================================================
  // 4. ESTADÍSTICA DESCRIPTIVA & MATRICES BASE
  // =========================================================================

  function _mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function _variance(arr, ddof = 1) {
    if (arr.length <= ddof) return 0;
    const m = _mean(arr);
    return arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - ddof);
  }

  function _sd(arr, ddof = 1) {
    return Math.sqrt(Math.max(0, _variance(arr, ddof)));
  }

  function _pearson(x, y) {
    const n = x.length;
    if (n < 2) return 0;
    const mx = _mean(x);
    const my = _mean(y);
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - mx;
      const dy = y[i] - my;
      num += dx * dy;
      dx2 += dx * dx;
      dy2 += dy * dy;
    }
    const den = Math.sqrt(dx2 * dy2);
    return den > 0 ? num / den : 0;
  }

  function _covMatrix(mat) {
    const n = mat.length;
    const p = mat[0].length;
    const means = new Array(p).fill(0);
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += mat[i][j];
      means[j] = s / n;
    }
    const cov = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let a = 0; a < p; a++) {
      for (let b = a; b < p; b++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += (mat[i][a] - means[a]) * (mat[i][b] - means[b]);
        const v = s / Math.max(1, n - 1);
        cov[a][b] = cov[b][a] = v;
      }
    }
    return cov;
  }

  function _corrMatrix(mat) {
    const p = mat[0].length;
    const cov = _covMatrix(mat);
    const R = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let a = 0; a < p; a++) {
      for (let b = a; b < p; b++) {
        if (a === b) {
          R[a][a] = 1.0;
        } else {
          const den = Math.sqrt(Math.max(0, cov[a][a] * cov[b][b]));
          const r = den > 0 ? Math.max(-1.0, Math.min(1.0, cov[a][b] / den)) : 0.0;
          R[a][b] = R[b][a] = r;
        }
      }
    }
    return R;
  }

  function _completeRowsMatrix(mat) {
    return (mat || []).filter((row) => row.every((v) => isFiniteNum(v)));
  }

  function _ranksWithTies(arr) {
    const n = arr.length;
    const indexed = arr.map((v, idx) => ({ v, idx })).sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && indexed[j + 1].v === indexed[i].v) j++;
      const avgRank = 0.5 * (i + j) + 1.0;
      for (let k = i; k <= j; k++) ranks[indexed[k].idx] = avgRank;
      i = j + 1;
    }
    return ranks;
  }

  function _spearmanRhoAndP(x, y) {
    const n = x.length;
    const rx = _ranksWithTies(x);
    const ry = _ranksWithTies(y);
    const rho = _pearson(rx, ry);
    let p = 1.0;
    if (n >= 4 && Math.abs(rho) < 1.0) {
      const t = Math.abs(rho) * Math.sqrt((n - 2) / Math.max(1e-15, 1.0 - rho * rho));
      p = tPvalue(t, n - 2);
    } else if (Math.abs(rho) >= 1.0) {
      p = 0.0;
    }
    return [rho, p];
  }

  function _pearsonAndP(x, y) {
    const n = x.length;
    const r = _pearson(x, y);
    let p = 1.0;
    if (n >= 4 && Math.abs(r) < 1.0) {
      const t = Math.abs(r) * Math.sqrt((n - 2) / Math.max(1e-15, 1.0 - r * r));
      p = tPvalue(t, n - 2);
    } else if (Math.abs(r) >= 1.0) {
      p = 0.0;
    }
    return [r, p];
  }

  function _extractMatrix(rows, itemIds, useZ = false, missingStrategy = "pairwise") {
    const keySuffix = useZ ? "_z" : "";
    const rawMat = rows.map((r) =>
      itemIds.map((iid) => {
        const val = r[`${iid}${keySuffix}`] !== undefined ? r[`${iid}${keySuffix}`] : r[iid];
        return isFiniteNum(val) ? val : NaN;
      })
    );
    if (!rawMat.length) return [];
    if (missingStrategy === "listwise") {
      return _completeRowsMatrix(rawMat);
    }
    if (missingStrategy === "mean_impute") {
      const k = itemIds.length;
      const colMeans = new Array(k).fill(0);
      for (let j = 0; j < k; j++) {
        const vals = rawMat.map((r) => r[j]).filter((v) => !Number.isNaN(v));
        colMeans[j] = vals.length ? _mean(vals) : 0.0;
      }
      return rawMat.map((r) => r.map((v, j) => (Number.isNaN(v) ? colMeans[j] : v)));
    }
    return rawMat;
  }

  // =========================================================================
  // 5. FIABILIDAD POLIMÓRFICA & ETAPA 0 & HTMT
  // =========================================================================

  function computeCronbachAlpha(mat) {
    const complete = _completeRowsMatrix(mat);
    const n = complete.length;
    const k = n > 0 ? complete[0].length : 0;
    if (n < 3 || k < 2) {
      return { applicable: false, reason: `Requiere N>=3 y k>=2 (actual N=${n}, k=${k})` };
    }
    const cov = _covMatrix(complete);
    let trCov = 0;
    let sumCov = 0;
    for (let i = 0; i < k; i++) {
      trCov += cov[i][i];
      for (let j = 0; j < k; j++) sumCov += cov[i][j];
    }
    if (sumCov <= 0) {
      return { applicable: false, reason: "Varianza total nula en los ítems." };
    }
    const alpha = (k / (k - 1.0)) * (1.0 - trCov / sumCov);
    const df1 = n - 1;
    const df2 = (n - 1) * (k - 1);
    const ciLow = 1.0 - (1.0 - alpha) * fPpf(0.975, df1, df2);
    const ciHigh = 1.0 - (1.0 - alpha) * fPpf(0.025, df1, df2);

    const R = _corrMatrix(complete);
    let offSum = 0;
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) if (i !== j) offSum += R[i][j];
    }
    const meanR = offSum / (k * (k - 1));

    const totalScores = complete.map((row) => row.reduce((a, b) => a + b, 0));
    const itemStats = [];
    for (let j = 0; j < k; j++) {
      const itemCol = complete.map((row) => row[j]);
      const restScores = complete.map((row, rIdx) => totalScores[rIdx] - row[j]);
      const rIt = _sd(itemCol, 1) > 0 && _sd(restScores, 1) > 0 ? _pearson(itemCol, restScores) : 0.0;

      let alphaIfDel = null;
      if (k > 2) {
        let subTr = 0, subSum = 0;
        for (let a = 0; a < k; a++) {
          if (a === j) continue;
          subTr += cov[a][a];
          for (let b = 0; b < k; b++) {
            if (b !== j) subSum += cov[a][b];
          }
        }
        if (subSum > 0) {
          alphaIfDel = ((k - 1) / (k - 2.0)) * (1.0 - subTr / subSum);
        }
      }
      itemStats.push({
        index: j,
        mean: roundTo(_mean(itemCol), 4),
        sd: roundTo(_sd(itemCol, 1), 4),
        r_item_total_corrected: roundTo(rIt, 6),
        alpha_if_deleted: alphaIfDel !== null ? roundTo(alphaIfDel, 6) : null,
        low_discrimination_flag: rIt < 0.30,
      });
    }

    return {
      applicable: true,
      n,
      k,
      alpha: roundTo(alpha, 6),
      ci_95_feldt: [roundTo(ciLow, 6), roundTo(ciHigh, 6)],
      mean_inter_item_r: roundTo(meanR, 6),
      negative_alpha_alert: alpha < 0,
      item_stats: itemStats,
    };
  }

  function computeKr20(mat) {
    const complete = _completeRowsMatrix(mat);
    const n = complete.length;
    const k = n > 0 ? complete[0].length : 0;
    if (n < 3 || k < 2) {
      return { applicable: false, reason: `Requiere N>=3 y k>=2 (actual N=${n}, k=${k})` };
    }
    const pI = new Array(k).fill(0);
    let sumPqSample = 0;
    for (let j = 0; j < k; j++) {
      const pj = _mean(complete.map((row) => row[j]));
      pI[j] = pj;
      sumPqSample += (n / (n - 1.0)) * (pj * (1.0 - pj));
    }
    const totalScores = complete.map((row) => row.reduce((a, b) => a + b, 0));
    const totalVar = _variance(totalScores, 1);
    if (totalVar <= 0) {
      return { applicable: false, reason: "Varianza total nula en ítems binarios." };
    }
    const kr20 = (k / (k - 1.0)) * (1.0 - sumPqSample / totalVar);
    const df1 = n - 1;
    const df2 = (n - 1) * (k - 1);
    const ciLow = 1.0 - (1.0 - kr20) * fPpf(0.975, df1, df2);
    const ciHigh = 1.0 - (1.0 - kr20) * fPpf(0.025, df1, df2);

    const itemsMeta = [];
    for (let j = 0; j < k; j++) {
      const col = complete.map((row) => row[j]);
      const rest = complete.map((row, idx) => totalScores[idx] - row[j]);
      const rPbis = _sd(col, 1) > 0 && _sd(rest, 1) > 0 ? _pearson(col, rest) : 0.0;
      itemsMeta.push({
        index: j,
        difficulty_p: roundTo(pI[j], 6),
        variance_pq: roundTo(pI[j] * (1.0 - pI[j]), 6),
        discrimination_r_pbis: roundTo(rPbis, 6),
      });
    }

    return {
      applicable: true,
      n,
      k,
      kr20: roundTo(kr20, 6),
      ci_95_feldt: [roundTo(ciLow, 6), roundTo(ciHigh, 6)],
      mean_score: roundTo(_mean(totalScores), 6),
      sd_score: roundTo(_sd(totalScores, 1), 6),
      items: itemsMeta,
    };
  }

  function computeSpearmanBrown2Items(x, y) {
    const xv = [];
    const yv = [];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (isFiniteNum(x[i]) && isFiniteNum(y[i])) {
        xv.push(x[i]);
        yv.push(y[i]);
      }
    }
    const n = xv.length;
    if (n < 4) return { applicable: false, reason: `Requiere N>=4 pares válidos (actual N=${n})` };
    const [rho, pVal] = _spearmanRhoAndP(xv, yv);
    const rSb = (1.0 + rho) !== 0 ? (2.0 * rho) / (1.0 + rho) : 0.0;
    let sbLo = rSb, sbHi = rSb;
    if (Math.abs(rho) < 0.9999) {
      const z = Math.atanh(rho);
      const se = 1.0 / Math.sqrt(Math.max(1, n - 3));
      const rLo = Math.tanh(z - 1.959964 * se);
      const rHi = Math.tanh(z + 1.959964 * se);
      sbLo = (2.0 * rLo) / (1.0 + rLo);
      sbHi = (2.0 * rHi) / (1.0 + rHi);
    }
    return {
      applicable: true,
      n,
      spearman_rho: roundTo(rho, 6),
      p_value: roundTo(pVal, 6),
      spearman_brown: roundTo(rSb, 6),
      ci_95: [roundTo(sbLo, 6), roundTo(sbHi, 6)],
    };
  }

  function _percentileLinear(sortedArr, q) {
    if (!sortedArr.length) return 0;
    const pos = (sortedArr.length - 1) * (q / 100.0);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sortedArr[lo];
    return sortedArr[lo] + (pos - lo) * (sortedArr[hi] - sortedArr[lo]);
  }

  function computePrerequisitesStage0(mat, itemIds, scaleMins = null, scaleMaxs = null) {
    if (!mat || !mat.length || !mat[0].length) {
      return { applicable: false, reason: "Matriz vacía." };
    }
    const nTotal = mat.length;
    const p = mat[0].length;
    const smins = scaleMins || new Array(p).fill(1.0);
    const smaxs = scaleMaxs || new Array(p).fill(5.0);

    let totalMissing = 0;
    const totalCells = nTotal * p;
    const itemDiagnostics = [];

    for (let j = 0; j < p; j++) {
      const valid = [];
      for (let i = 0; i < nTotal; i++) {
        const v = mat[i][j];
        if (isFiniteNum(v)) valid.push(v);
        else totalMissing++;
      }
      const nVal = valid.length;
      const nMiss = nTotal - nVal;
      const pctMiss = nTotal > 0 ? nMiss / nTotal : 0.0;

      let meanV = 0, sdV = 0, medV = 0, iqrV = 0, g1 = 0, g2 = 0, pctFloor = 0, pctCeiling = 0;
      if (nVal >= 3) {
        meanV = _mean(valid);
        sdV = _sd(valid, 1);
        const sorted = valid.slice().sort((a, b) => a - b);
        medV = _percentileLinear(sorted, 50);
        iqrV = _percentileLinear(sorted, 75) - _percentileLinear(sorted, 25);

        if (sdV > 0) {
          // Sample m2 = sum((x-mean)^2)/n, Fisher adjusted g1 & g2 (idéntico a scipy bias=False / R psych type=2)
          let m2 = 0, m3 = 0, m4 = 0;
          for (const v of valid) {
            const d = v - meanV;
            const d2 = d * d;
            m2 += d2;
            m3 += d2 * d;
            m4 += d2 * d2;
          }
          m2 /= nVal; m3 /= nVal; m4 /= nVal;
          const b1 = m3 / Math.pow(m2, 1.5);
          g1 = (Math.sqrt(nVal * (nVal - 1.0)) / (nVal - 2.0)) * b1;
          if (nVal >= 4) {
            const g2Pop = m4 / (m2 * m2) - 3.0;
            g2 = ((nVal - 1.0) / ((nVal - 2.0) * (nVal - 3.0))) * ((nVal + 1.0) * g2Pop + 6.0);
          }
        }
        pctFloor = valid.filter((v) => v <= smins[j] + 1e-9).length / nVal;
        pctCeiling = valid.filter((v) => v >= smaxs[j] - 1e-9).length / nVal;
      }

      const alerts = [];
      if (pctMiss > 0.05) alerts.push("MISSING_GT_5PCT");
      if (Math.abs(g1) > 1.5) alerts.push("HIGH_SKEWNESS");
      if (Math.abs(g2) > 2.0) alerts.push("HIGH_KURTOSIS");
      if (pctFloor > FLOOR_CEILING_THRESHOLD) alerts.push("FLOOR_EFFECT_GT_15PCT");
      if (pctCeiling > FLOOR_CEILING_THRESHOLD) alerts.push("CEILING_EFFECT_GT_15PCT");

      itemDiagnostics.push({
        item_id: itemIds[j],
        n_valid: nVal,
        n_missing: nMiss,
        pct_missing: roundTo(pctMiss, 6),
        mean: roundTo(meanV, 6),
        sd: roundTo(sdV, 6),
        median: roundTo(medV, 6),
        iqr: roundTo(iqrV, 6),
        skewness_g1: roundTo(g1, 6),
        kurtosis_g2: roundTo(g2, 6),
        pct_floor: roundTo(pctFloor, 6),
        pct_ceiling: roundTo(pctCeiling, 6),
        alerts,
      });
    }

    const complete = _completeRowsMatrix(mat);
    const nComp = complete.length;
    let kmoResult = { applicable: false };
    let bartlettResult = { applicable: false };
    let mardiaResult = { applicable: false };

    if (nComp > p && p >= 2) {
      const R = _corrMatrix(complete);
      const luR = luDecomposeAndSolve(R);
      const detR = !luR.singular ? luR.sign * Math.exp(luR.logDet) : 0.0;

      if (detR > 1e-15) {
        const chi2Bart = -(nComp - 1.0 - (2.0 * p + 5.0) / 6.0) * Math.log(detR);
        const dfBart = (p * (p - 1)) / 2;
        const pBart = chi2Sf(Math.max(0.0, chi2Bart), dfBart);
        bartlettResult = {
          applicable: true,
          chi2: roundTo(chi2Bart, 6),
          df: dfBart,
          p_value: pBart,
          det_R: detR,
          adequate: pBart < 0.05 && detR > 1e-5,
        };

        const Rinv = invertMatrix(R);
        if (Rinv) {
          let r2Sum = 0;
          let q2Sum = 0;
          const msaPerItem = {};
          for (let j = 0; j < p; j++) {
            let r2Col = 0;
            let q2Col = 0;
            for (let i = 0; i < p; i++) {
              if (i === j) continue;
              const rSq = R[i][j] * R[i][j];
              const qij = -Rinv[i][j] / Math.sqrt(Math.max(1e-15, Rinv[i][i] * Rinv[j][j]));
              const qSq = qij * qij;
              r2Col += rSq;
              q2Col += qSq;
            }
            r2Sum += r2Col;
            q2Sum += q2Col;
            const msaJ = (r2Col + q2Col) > 0 ? r2Col / (r2Col + q2Col) : 0.0;
            msaPerItem[itemIds[j]] = roundTo(msaJ, 6);
            if (msaJ < 0.60) itemDiagnostics[j].alerts.push("LOW_MSA_LT_060");
          }
          const kmoGlobal = (r2Sum + q2Sum) > 0 ? r2Sum / (r2Sum + q2Sum) : 0.0;
          kmoResult = {
            applicable: true,
            kmo_global: roundTo(kmoGlobal, 6),
            msa_per_item: msaPerItem,
            adequate: kmoGlobal >= 0.60,
          };
        }
      } else {
        bartlettResult = { applicable: false, det_R: detR, reason: "Matriz de correlación singular (det(R) <= 0)." };
      }

      // Mardia Multivariate Skewness & Kurtosis (psych::mardia sobre S_mle = Xc' Xc / nComp)
      const colMeans = new Array(p).fill(0);
      for (let j = 0; j < p; j++) {
        let s = 0;
        for (let i = 0; i < nComp; i++) s += complete[i][j];
        colMeans[j] = s / nComp;
      }
      const xc = complete.map((row) => row.map((v, j) => v - colMeans[j]));
      const Smle = Array.from({ length: p }, () => new Array(p).fill(0));
      for (let a = 0; a < p; a++) {
        for (let b = a; b < p; b++) {
          let s = 0;
          for (let i = 0; i < nComp; i++) s += xc[i][a] * xc[i][b];
          Smle[a][b] = Smle[b][a] = s / nComp;
        }
      }
      const Sinv = invertMatrix(Smle);
      if (Sinv) {
        const xcSinv = matMul(xc, Sinv);
        let sumB1p = 0;
        let sumB2p = 0;
        for (let i = 0; i < nComp; i++) {
          let dii = 0;
          for (let k = 0; k < p; k++) dii += xcSinv[i][k] * xc[i][k];
          sumB2p += dii * dii;
          for (let j = 0; j < nComp; j++) {
            let dij = 0;
            for (let k = 0; k < p; k++) dij += xcSinv[i][k] * xc[j][k];
            sumB1p += dij * dij * dij;
          }
        }
        const b1p = sumB1p / (nComp * nComp);
        const b2p = sumB2p / nComp;
        const expectedB2p = p * (p + 2.0);
        const sdB2p = Math.sqrt((8.0 * p * (p + 2.0)) / nComp);
        const zKurt = sdB2p > 0 ? (b2p - expectedB2p) / sdB2p : 0.0;
        const pKurt = 2.0 * normSf(Math.abs(zKurt));
        const chiSkew = (nComp * b1p) / 6.0;
        const dfSkew = (p * (p + 1) * (p + 2)) / 6;
        const pSkew = chi2Sf(chiSkew, dfSkew);
        mardiaResult = {
          applicable: true,
          b1p_skew: roundTo(b1p, 6),
          p_skew: roundTo(pSkew, 6),
          b2p_kurtosis: roundTo(b2p, 6),
          z_kurtosis: roundTo(zKurt, 6),
          p_kurtosis: roundTo(pKurt, 6),
          multivariate_normality: pKurt >= 0.05 && pSkew >= 0.05,
          recommended_estimator: (pKurt < 0.05 || pSkew < 0.05) ? "MLR / WLSMV (robusto)" : "ML / WLSMV",
        };
      }
    }

    return {
      applicable: true,
      n_total: nTotal,
      n_complete_listwise: nComp,
      total_missing_cells: totalMissing,
      pct_missing_global: totalCells > 0 ? roundTo(totalMissing / totalCells, 6) : 0.0,
      items: itemDiagnostics,
      kmo: kmoResult,
      bartlett: bartlettResult,
      mardia: mardiaResult,
    };
  }

  function computeHtmtMatrix(R, factorIndices) {
    const factors = Object.keys(factorIndices);
    if (factors.length < 2) {
      return { applicable: false, reason: "HTMT requiere al menos 2 factores latentes." };
    }
    const matrix = {};
    const alerts = [];
    for (const f1 of factors) {
      matrix[f1] = {};
      for (const f2 of factors) {
        if (f1 === f2) {
          matrix[f1][f2] = 1.0;
          continue;
        }
        const idx1 = factorIndices[f1];
        const idx2 = factorIndices[f2];
        const hetero = [];
        for (const i of idx1) for (const j of idx2) hetero.push(R[i][j]);
        const mono1 = [];
        for (let a = 0; a < idx1.length; a++) for (let b = a + 1; b < idx1.length; b++) mono1.push(R[idx1[a]][idx1[b]]);
        const mono2 = [];
        for (let a = 0; a < idx2.length; a++) for (let b = a + 1; b < idx2.length; b++) mono2.push(R[idx2[a]][idx2[b]]);

        if (!hetero.length || !mono1.length || !mono2.length) {
          matrix[f1][f2] = null;
          continue;
        }
        const m1 = _mean(mono1);
        const m2 = _mean(mono2);
        const denom = m1 > 0 && m2 > 0 ? Math.sqrt(m1 * m2) : 0.0;
        const htmtVal = denom > 0 ? Math.abs(_mean(hetero)) / denom : 99.9;
        const htmtRounded = roundTo(htmtVal, 6);
        matrix[f1][f2] = htmtRounded;
        if (f1 < f2 && htmtVal >= HTMT_STRICT_THRESHOLD) {
          alerts.push({
            pair: [f1, f2],
            htmt: htmtRounded,
            severity: htmtVal >= 0.90 ? "CRITICAL_GE_090" : "WARNING_GE_085",
          });
        }
      }
    }
    return {
      applicable: true,
      factors,
      matrix,
      alerts,
      discriminant_validity_ok: alerts.length === 0,
    };
  }

  // =========================================================================
  // 6. CFA MÁXIMA VEROSIMILITUD EXACTA (Projected L-BFGS-B en JS Puro)
  // =========================================================================

  function _rmseaCi90(chi2Val, df, n) {
    if (df <= 0 || n <= 1) return [0.0, 0.0];
    function findNcp(targetCdf) {
      if (chi2Val <= 0) return 0.0;
      if (ncx2Cdf(chi2Val, df, 0.0) <= targetCdf) return 0.0;
      let lo = 0.0;
      let hi = Math.max(chi2Val * 2.5, df * 4.0, 60.0);
      while (ncx2Cdf(chi2Val, df, hi) > targetCdf && hi < 1e7) hi *= 2.0;
      for (let it = 0; it < 65; it++) {
        const mid = 0.5 * (lo + hi);
        if (ncx2Cdf(chi2Val, df, mid) > targetCdf) lo = mid;
        else hi = mid;
      }
      return 0.5 * (lo + hi);
    }
    const ncpLow = findNcp(0.95);
    const ncpHigh = findNcp(0.05);
    return [
      roundTo(Math.sqrt(Math.max(0.0, ncpLow / (df * (n - 1.0)))), 6),
      roundTo(Math.sqrt(Math.max(0.0, ncpHigh / (df * (n - 1.0)))), 6),
    ];
  }

  function _projectedLbfgsB(fFn, x0, bounds, maxIter = 350) {
    const dim = x0.length;
    function clampVec(v) {
      const out = new Array(dim);
      for (let i = 0; i < dim; i++) {
        out[i] = Math.max(bounds[i][0], Math.min(bounds[i][1], v[i]));
      }
      return out;
    }
    function gradFn(x) {
      const g = new Array(dim);
      const hBase = 1e-6;
      for (let i = 0; i < dim; i++) {
        const h = hBase;
        const xp = x.slice(); xp[i] = Math.min(bounds[i][1], x[i] + h);
        const xm = x.slice(); xm[i] = Math.max(bounds[i][0], x[i] - h);
        const denom = xp[i] - xm[i];
        g[i] = denom > 0 ? (fFn(xp) - fFn(xm)) / denom : 0.0;
      }
      return g;
    }
    function dot(a, b) {
      let s = 0;
      for (let i = 0; i < a.length; i++) s += a[i] * b[i];
      return s;
    }

    let x = clampVec(x0);
    let fx = fFn(x);
    let g = gradFn(x);
    const M = 10;
    const sHist = [];
    const yHist = [];

    for (let iter = 0; iter < maxIter; iter++) {
      // L-BFGS two-loop recursion
      const q = g.slice();
      const kLen = sHist.length;
      const alpha = new Array(kLen);
      const rho = new Array(kLen);
      for (let i = kLen - 1; i >= 0; i--) {
        const sy = dot(sHist[i], yHist[i]);
        rho[i] = Math.abs(sy) > 1e-18 ? 1.0 / sy : 0.0;
        alpha[i] = rho[i] * dot(sHist[i], q);
        for (let j = 0; j < dim; j++) q[j] -= alpha[i] * yHist[i][j];
      }
      let gamma = 1.0;
      if (kLen > 0) {
        const last = kLen - 1;
        const yy = dot(yHist[last], yHist[last]);
        if (yy > 1e-18) gamma = dot(sHist[last], yHist[last]) / yy;
      }
      const r = q.map((v) => gamma * v);
      for (let i = 0; i < kLen; i++) {
        const beta = rho[i] * dot(yHist[i], r);
        const coef = alpha[i] - beta;
        for (let j = 0; j < dim; j++) r[j] += sHist[i][j] * coef;
      }
      let dir = r.map((v) => -v);
      // Cero en componentes bloqueados en la frontera y apuntando afuera
      for (let i = 0; i < dim; i++) {
        if (x[i] <= bounds[i][0] + 1e-12 && dir[i] < 0) dir[i] = 0;
        if (x[i] >= bounds[i][1] - 1e-12 && dir[i] > 0) dir[i] = 0;
      }
      if (dot(g, dir) >= 0) {
        dir = g.map((v, i) => {
          if (x[i] <= bounds[i][0] + 1e-12 && v > 0) return 0;
          if (x[i] >= bounds[i][1] - 1e-12 && v < 0) return 0;
          return -v;
        });
      }

      let step = 1.0;
      let accepted = false;
      let xNext = x;
      let fNext = fx;
      const gDotD = dot(g, dir);
      if (Math.abs(gDotD) < 1e-14) break;

      for (let ls = 0; ls < 35; ls++) {
        const cand = clampVec(x.map((xi, i) => xi + step * dir[i]));
        const fc = fFn(cand);
        const sCand = cand.map((ci, i) => ci - x[i]);
        const expectedDesc = dot(g, sCand);
        if (fc <= fx + 1e-4 * Math.min(0, expectedDesc) || fc < fx) {
          xNext = cand;
          fNext = fc;
          accepted = true;
          break;
        }
        step *= 0.5;
      }

      if (!accepted) break;
      const sVec = xNext.map((v, i) => v - x[i]);
      const gNext = gradFn(xNext);
      const yVec = gNext.map((v, i) => v - g[i]);
      if (dot(sVec, yVec) > 1e-16) {
        sHist.push(sVec);
        yHist.push(yVec);
        if (sHist.length > M) { sHist.shift(); yHist.shift(); }
      }
      const fRelChange = Math.abs(fx - fNext) / Math.max(1.0, Math.abs(fx));
      x = xNext;
      fx = fNext;
      g = gNext;
      if (fRelChange < 1e-12 && iter > 5) break;
    }

    return { x, fun: fx, success: true };
  }

  function computeCfaMl(S, n, factorIndices, itemIds) {
    const factors = Object.keys(factorIndices);
    const d = factors.length;
    const p = S.length;

    const under3 = factors.filter((f) => factorIndices[f].length < MIN_ITEMS_PER_FACTOR);
    if (under3.length > 0) {
      return {
        applicable: false,
        reason: `Inviable: dimensiones con < 3 ítems violan identificabilidad CFA: ${JSON.stringify(under3)}`,
        deficit_dimensions: under3,
      };
    }
    if (n <= p) {
      return { applicable: false, reason: `Tamaño muestral insuficiente (N=${n} <= p=${p}).` };
    }

    const nMoments = (p * (p + 1)) / 2;
    const nPhi = (d * (d - 1)) / 2;
    const nParams = p + p + nPhi;
    const df = nMoments - nParams;
    if (df < 0) return { applicable: false, reason: `Modelo sub-identificado (gl = ${df} < 0).` };

    if (jacobiMinEigenvalue(S) <= 1e-7) {
      return { applicable: false, reason: "Matriz S no definida positiva; imposibilita CFA ML." };
    }
    const luS = luDecomposeAndSolve(S);
    if (luS.singular) return { applicable: false, reason: "Matriz S singular." };
    const logDetS = luS.logDet;

    const itemFactorMap = {};
    factors.forEach((fName, fIdx) => {
      for (const iIdx of factorIndices[fName]) itemFactorMap[iIdx] = fIdx;
    });

    const initLam = new Array(p).fill(0.72);
    for (const fName of factors) {
      const idxs = factorIndices[fName];
      if (idxs.length >= 2) {
        let sumR = 0, cnt = 0;
        for (const a of idxs) for (const b of idxs) if (a !== b) { sumR += S[a][b]; cnt++; }
        const avgR = Math.max(0.2, Math.min(0.85, sumR / Math.max(1, cnt)));
        for (const iIdx of idxs) initLam[iIdx] = Math.sqrt(avgR);
      }
    }
    const initTheta = initLam.map((l) => Math.max(0.08, Math.min(0.92, 1.0 - l * l)));
    const initPhi = new Array(nPhi).fill(0.25);
    const x0 = [...initLam, ...initTheta, ...initPhi];
    const bounds = [
      ...Array.from({ length: p }, () => [-1.05, 1.05]),
      ...Array.from({ length: p }, () => [0.005, 1.2]),
      ...Array.from({ length: nPhi }, () => [-0.98, 0.98]),
    ];

    function unpack(x) {
      const Lambda = Array.from({ length: p }, () => new Array(d).fill(0));
      for (let i = 0; i < p; i++) Lambda[i][itemFactorMap[i]] = x[i];
      const Phi = Array.from({ length: d }, (_, a) => Array.from({ length: d }, (__, b) => (a === b ? 1.0 : 0.0)));
      let kPtr = 0;
      for (let a = 0; a < d; a++) {
        for (let b = a + 1; b < d; b++) {
          Phi[a][b] = Phi[b][a] = x[2 * p + kPtr];
          kPtr++;
        }
      }
      const Theta = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (__, j) => (i === j ? x[p + i] : 0.0)));
      return { Lambda, Theta, Phi };
    }

    function fMl(x) {
      const { Lambda, Theta, Phi } = unpack(x);
      if (d > 1) {
        const minEigPhi = jacobiMinEigenvalue(Phi);
        if (minEigPhi <= 0.02) return 1e6 + (0.02 - minEigPhi) * 1e5;
      }
      const LP = matMul(Lambda, Phi);
      const LPL = matMul(LP, matTranspose(Lambda));
      const Sigma = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (__, j) => LPL[i][j] + Theta[i][j]));
      const luSig = luDecomposeAndSolve(Sigma, S);
      if (luSig.singular || luSig.sign <= 0) return 1e6;
      let tr = 0;
      for (let i = 0; i < p; i++) tr += luSig.solved[i][i];
      const val = luSig.logDet + tr - logDetS - p;
      return Math.max(0.0, val);
    }

    const res = _projectedLbfgsB(fMl, x0, bounds, 350);
    const { Lambda, Theta, Phi } = unpack(res.x);
    const SigmaHat = matMul(matMul(Lambda, Phi), matTranspose(Lambda)).map((row, i) => row.map((v, j) => v + Theta[i][j]));
    const fMin = res.fun;

    const diagSig = SigmaHat.map((row, i) => Math.sqrt(Math.max(1e-9, row[i])));
    const stdLoadings = {};
    const heywoodCases = [];
    for (let i = 0; i < p; i++) {
      const fIdx = itemFactorMap[i];
      const lamStd = Lambda[i][fIdx] / diagSig[i];
      const thetaStd = Theta[i][i] / (diagSig[i] * diagSig[i]);
      stdLoadings[itemIds[i]] = {
        factor: factors[fIdx],
        loading_std: roundTo(lamStd, 6),
        r2_communality: roundTo(lamStd * lamStd, 6),
        uniqueness_theta: roundTo(thetaStd, 6),
      };
      if (Math.abs(lamStd) >= 1.0 || thetaStd <= 0.01) {
        heywoodCases.push({ item_id: itemIds[i], loading_std: roundTo(lamStd, 4), theta_std: roundTo(thetaStd, 4) });
      }
    }
    for (let a = 0; a < d; a++) {
      for (let b = a + 1; b < d; b++) {
        if (Math.abs(Phi[a][b]) >= 0.99) {
          heywoodCases.push({ factor_pair: [factors[a], factors[b]], phi: roundTo(Phi[a][b], 4) });
        }
      }
    }

    const chi2Model = n * fMin;
    const pValue = df > 0 ? chi2Sf(chi2Model, df) : 1.0;
    const chi2Df = df > 0 ? chi2Model / df : 0.0;

    let logDetSdiag = 0.0;
    for (let i = 0; i < p; i++) logDetSdiag += Math.log(Math.max(1e-12, S[i][i]));
    const fNull = Math.max(0.0, logDetSdiag - logDetS);
    const chi2Null = n * fNull;
    const dfNull = (p * (p - 1)) / 2;

    let cfi = (chi2Null - dfNull) > 0
      ? 1.0 - Math.max(chi2Model - df, 0.0) / Math.max(chi2Null - dfNull, chi2Model - df, 1e-9)
      : 1.0;
    cfi = Math.min(1.0, Math.max(0.0, cfi));

    const tli = (df > 0 && dfNull > 0 && ((chi2Null / dfNull) - 1.0) !== 0)
      ? ((chi2Null / dfNull) - (chi2Model / df)) / ((chi2Null / dfNull) - 1.0)
      : 1.0;

    const rmsea = df > 0 ? Math.sqrt(Math.max(0.0, (chi2Model - df) / (df * Math.max(1, n - 1)))) : 0.0;
    const rmseaCi = _rmseaCi90(chi2Model, df, n);

    let srmrSum = 0.0;
    for (let i = 0; i < p; i++) {
      for (let j = 0; j <= i; j++) {
        const denom = Math.sqrt(Math.max(1e-12, S[i][i] * S[j][j]));
        const diff = (S[i][j] - SigmaHat[i][j]) / denom;
        srmrSum += diff * diff;
      }
    }
    const srmr = Math.sqrt((2.0 / (p * (p + 1))) * srmrSum);

    const ll = -0.5 * n * (p * Math.log(2.0 * Math.PI) + logDetS + p + fMin);
    const aic = -2.0 * ll + 2.0 * nParams;
    const bic = -2.0 * ll + nParams * Math.log(Math.max(2, n));
    const sabic = n > 24 ? -2.0 * ll + nParams * Math.log((n + 2.0) / 24.0) : bic;

    const factorMetrics = {};
    for (const [fName, idxs] of Object.entries(factorIndices)) {
      const lams = idxs.map((i) => stdLoadings[itemIds[i]].loading_std);
      const thetas = idxs.map((i) => stdLoadings[itemIds[i]].uniqueness_theta);
      const sumLam = lams.reduce((a, b) => a + b, 0);
      const sumLamSq = sumLam * sumLam;
      const sumTheta = thetas.reduce((a, b) => a + b, 0);
      const omega = (sumLamSq + sumTheta) > 0 ? sumLamSq / (sumLamSq + sumTheta) : 0.0;
      const ave = lams.reduce((a, l) => a + l * l, 0) / lams.length;
      factorMetrics[fName] = {
        n_items: idxs.length,
        omega_mcdonald: roundTo(omega, 6),
        ave: roundTo(ave, 6),
        composite_reliability_cr: roundTo(omega, 6),
        sqrt_ave: roundTo(Math.sqrt(Math.max(0.0, ave)), 6),
      };
    }

    const factorCorrMatrix = {};
    factors.forEach((fa, a) => {
      factorCorrMatrix[fa] = {};
      factors.forEach((fb, b) => {
        factorCorrMatrix[fa][fb] = roundTo(Phi[a][b], 6);
      });
    });

    const htmtRes = computeHtmtMatrix(S, factorIndices);

    return {
      applicable: true,
      converged: res.success,
      n,
      p_items: p,
      d_factors: d,
      n_params: nParams,
      chi2: roundTo(chi2Model, 6),
      df,
      p_value: roundTo(pValue, 6),
      chi2_df: roundTo(chi2Df, 6),
      cfi: roundTo(cfi, 6),
      tli: roundTo(tli, 6),
      rmsea: roundTo(rmsea, 6),
      rmsea_ci_90: rmseaCi,
      srmr: roundTo(srmr, 6),
      aic: roundTo(aic, 4),
      bic: roundTo(bic, 4),
      sabic: roundTo(sabic, 4),
      loadings: stdLoadings,
      factor_metrics: factorMetrics,
      factor_correlations: factorCorrMatrix,
      htmt: htmtRes,
      heywood_cases: heywoodCases,
      has_heywood: heywoodCases.length > 0,
      fit_verdict: cfi >= 0.90 && srmr <= 0.08 && heywoodCases.length === 0 ? "ADEQUATE_FIT" : "MISFIT_OR_HEYWOOD",
    };
  }

  // =========================================================================
  // 7. AUDITORÍA MUESTRAL WHAT-IF & VALIDADOR PRE-CAMPO & HOLM/FDR
  // =========================================================================

  function auditSampleQuality(rows, overlay) {
    const items = _getOverlayItems(overlay);
    const likertItems = items.filter((it) => it.role === "LIKERT_REFLECTIVA");
    const itemIds = likertItems.map((it) => it.id);
    const revIds = likertItems.filter((it) => it.is_reverse).map((it) => it.id);
    const dirIds = likertItems.filter((it) => !it.is_reverse).map((it) => it.id);
    const itemBounds = {};
    for (const it of likertItems) {
      itemBounds[it.id] = [Number(it.scale_min || 1), Number(it.scale_max || 5)];
    }

    if (!rows || !rows.length || itemIds.length < 3) {
      return { applicable: false, n_total: rows ? rows.length : 0, straight_lining_indices: [], outlier_indices: [], incongruent_indices: [], row_flags: [] };
    }

    const mat = _extractMatrix(rows, itemIds, false, "pairwise");
    const completeMat = [];
    const completeIndices = [];
    mat.forEach((row, idx) => {
      if (row.every((v) => !Number.isNaN(v))) {
        completeMat.push(row);
        completeIndices.push(idx);
      }
    });

    function normVal(iid, v) {
      if (!isFiniteNum(v)) return null;
      const [smin, smax] = itemBounds[iid] || [1, 5];
      const rng = smax - smin;
      return rng > 0 ? (v - smin) / rng : 0.0;
    }

    const straightIndices = [];
    const incongruentIndices = [];
    rows.forEach((r, i) => {
      const vals = itemIds.map((iid) => r[iid]).filter((v) => isFiniteNum(v));
      if (vals.length >= 3 && _variance(vals, 0) === 0.0) straightIndices.push(i);
      if (revIds.length && dirIds.length) {
        const dNorm = dirIds.map((iid) => normVal(iid, r[iid])).filter((v) => v !== null);
        const rNorm = revIds.map((iid) => normVal(iid, r[iid])).filter((v) => v !== null);
        if (dNorm.length && rNorm.length) {
          const dm = _mean(dNorm);
          const rm = _mean(rNorm);
          if ((dm >= 0.80 && rm <= 0.20) || (dm <= 0.20 && rm >= 0.80)) incongruentIndices.push(i);
        }
      }
    });

    const pDim = itemIds.length;
    const critChi2 = chi2Ppf(0.999, pDim);
    const outlierIndices = [];
    const mahalDistances = {};

    if (completeMat.length > pDim + 2) {
      const mu = new Array(pDim).fill(0);
      for (let j = 0; j < pDim; j++) {
        let s = 0;
        for (let i = 0; i < completeMat.length; i++) s += completeMat[i][j];
        mu[j] = s / completeMat.length;
      }
      const cov = _covMatrix(completeMat);
      for (let i = 0; i < pDim; i++) cov[i][i] += 1e-6;
      const covInv = invertMatrix(cov);
      if (covInv) {
        completeIndices.forEach((origIdx, localIdx) => {
          const diff = completeMat[localIdx].map((v, j) => v - mu[j]);
          let d2 = 0;
          for (let a = 0; a < pDim; a++) {
            for (let b = 0; b < pDim; b++) d2 += diff[a] * covInv[a][b] * diff[b];
          }
          mahalDistances[origIdx] = roundTo(d2, 4);
          if (d2 > critChi2) outlierIndices.push(origIdx);
        });
      }
    }

    const rowFlags = rows.map((_, i) => {
      const anomalies = [];
      if (straightIndices.includes(i)) anomalies.push("Straight-Lining");
      if (incongruentIndices.includes(i)) anomalies.push("Incongruencia Inverso");
      if (outlierIndices.includes(i)) anomalies.push("Outlier Mahalanobis D²");
      return {
        row_index: i,
        status: anomalies.length === 0 ? "Óptima" : anomalies.join(", "),
        anomalies,
        mahalanobis_d2: mahalDistances[i] !== undefined ? mahalDistances[i] : null,
      };
    });

    const uniqueFlagged = new Set([...straightIndices, ...incongruentIndices, ...outlierIndices]);
    return {
      applicable: true,
      n_total: rows.length,
      critical_d2_threshold_p001: roundTo(critChi2, 4),
      straight_lining_indices: straightIndices,
      incongruent_indices: incongruentIndices,
      outlier_indices: outlierIndices,
      total_flagged_unique: uniqueFlagged.size,
      row_flags: rowFlags,
    };
  }

  function computeAikenV(ratings, scaleMin = 1, scaleMax = 4) {
    const nJ = ratings.length;
    const c = scaleMax - scaleMin;
    if (nJ < 2 || c <= 0) return { applicable: false, reason: "Se requieren >= 2 jueces y rango válido." };
    const meanScore = _mean(ratings);
    const v = (meanScore - scaleMin) / c;
    const vClamped = Math.max(0.0, Math.min(1.0, v));

    const z2 = Z_95 * Z_95;
    const nk = nJ * c;
    const denom = 2.0 * (nk + z2);
    const rad = Z_95 * Math.sqrt(4.0 * nk * vClamped * (1.0 - vClamped) + z2);
    const ciLow = Math.max(0.0, (2.0 * nk * vClamped + z2 - rad) / denom);
    const ciHigh = Math.min(1.0, (2.0 * nk * vClamped + z2 + rad) / denom);

    return {
      applicable: true,
      n_judges: nJ,
      aiken_v: roundTo(vClamped, 6),
      ci_95_wilson: [roundTo(ciLow, 6), roundTo(ciHigh, 6)],
      valid_ci_lower_ge_070: ciLow >= 0.70,
      valid_v_ge_080: vClamped >= 0.80,
    };
  }

  function checkPrefieldIdentifiability(dimensions) {
    const dims = Object.entries(dimensions || {});
    const p = dims.reduce((acc, [, arr]) => acc + arr.length, 0);
    const d = dims.length;
    const deficit = dims.filter(([, arr]) => arr.length < MIN_ITEMS_PER_FACTOR).map(([k]) => k);
    const nMoments = (p * (p + 1)) / 2;
    const nParams = p + p + (d * (d - 1)) / 2;
    const df = nMoments - nParams;
    return {
      total_items: p,
      total_factors: d,
      moments: nMoments,
      free_params: nParams,
      degrees_of_freedom_gl: df,
      identifiable_cfa: df >= 0 && deficit.length === 0 && d >= 1,
      deficit_dimensions: deficit,
      synthetic_data_used: false,
      gate_status: df >= 0 && deficit.length === 0 ? "ESTRUCTURA_IDENTIFICABLE" : "DEFICIT_ESTRUCTURAL_PRECAMPO",
    };
  }

  function applyHolmFdr(pValues) {
    const m = pValues ? pValues.length : 0;
    if (m === 0) return [[], []];
    const order = Array.from({ length: m }, (_, i) => i).sort((a, b) => pValues[a] - pValues[b]);

    const holmSorted = new Array(m);
    let runningMax = 0.0;
    for (let rank = 0; rank < m; rank++) {
      const idx = order[rank];
      const adj = Math.min(1.0, pValues[idx] * (m - rank));
      runningMax = Math.max(runningMax, adj);
      holmSorted[rank] = runningMax;
    }
    const holmOut = new Array(m);
    order.forEach((origIdx, rank) => { holmOut[origIdx] = roundTo(holmSorted[rank], 8); });

    const bhSorted = new Array(m);
    let runningMin = 1.0;
    for (let rank = m - 1; rank >= 0; rank--) {
      const idx = order[rank];
      const adj = Math.min(1.0, (pValues[idx] * m) / (rank + 1));
      runningMin = Math.min(runningMin, adj);
      bhSorted[rank] = runningMin;
    }
    const bhOut = new Array(m);
    order.forEach((origIdx, rank) => { bhOut[origIdx] = roundTo(bhSorted[rank], 8); });

    return [holmOut, bhOut];
  }

  // =========================================================================
  // 8. LABORATORIO BIVARIADO & ARENA-SKILL & ORQUESTADORES
  // =========================================================================

  function _ols(x, y) {
    const mx = _mean(x), my = _mean(y);
    let num = 0, den = 0;
    for (let i = 0; i < x.length; i++) {
      num += (x[i] - mx) * (y[i] - my);
      den += (x[i] - mx) * (x[i] - mx);
    }
    const slope = den > 0 ? num / den : 0.0;
    return [slope, my - slope * mx];
  }

  function _welchT(g1, g2) {
    const n1 = g1.length, n2 = g2.length;
    const m1 = _mean(g1), m2 = _mean(g2);
    const v1 = _variance(g1, 1) / n1;
    const v2 = _variance(g2, 1) / n2;
    const se = Math.sqrt(Math.max(1e-18, v1 + v2));
    const tStat = (m1 - m2) / se;
    const df = ((v1 + v2) * (v1 + v2)) / (Math.max(1e-18, (v1 * v1) / Math.max(1, n1 - 1) + (v2 * v2) / Math.max(1, n2 - 1)));
    return [tStat, tPvalue(Math.abs(tStat), df)];
  }

  function _mannWhitneyU(g1, g2) {
    const combined = [...g1.map((v) => ({ v, grp: 1 })), ...g2.map((v) => ({ v, grp: 2 }))];
    const ranks = _ranksWithTies(combined.map((c) => c.v));
    let r1 = 0;
    combined.forEach((c, idx) => { if (c.grp === 1) r1 += ranks[idx]; });
    const n1 = g1.length, n2 = g2.length;
    const u1 = r1 - (n1 * (n1 + 1)) / 2.0;
    const mu = (n1 * n2) / 2.0;
    const sig = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12.0);
    const z = sig > 0 ? (u1 - mu) / sig : 0.0;
    return [Math.min(u1, n1 * n2 - u1), 2.0 * normSf(Math.abs(z))];
  }

  function _oneWayAnova(gArrays) {
    const k = gArrays.length;
    const allY = gArrays.flat();
    const N = allY.length;
    const gm = _mean(allY);
    let ssB = 0, ssW = 0;
    for (const g of gArrays) {
      const m = _mean(g);
      ssB += g.length * (m - gm) * (m - gm);
      for (const y of g) ssW += (y - m) * (y - m);
    }
    const dfB = k - 1;
    const dfW = N - k;
    const msB = ssB / Math.max(1, dfB);
    const msW = ssW / Math.max(1, dfW);
    const fStat = msW > 0 ? msB / msW : 0.0;
    const pVal = 1.0 - fCdf(fStat, dfB, dfW);
    return [fStat, Math.max(0.0, Math.min(1.0, pVal)), ssB / Math.max(1e-18, ssB + ssW)];
  }

  function _kruskalWallis(gArrays) {
    const all = gArrays.flat();
    const N = all.length;
    const ranks = _ranksWithTies(all);
    let offset = 0, sumRi2Ni = 0;
    for (const g of gArrays) {
      let rSum = 0;
      for (let i = 0; i < g.length; i++) rSum += ranks[offset + i];
      sumRi2Ni += (rSum * rSum) / g.length;
      offset += g.length;
    }
    const H = (12.0 / (N * (N + 1))) * sumRi2Ni - 3.0 * (N + 1);
    const pVal = chi2Sf(Math.max(0.0, H), gArrays.length - 1);
    return [H, pVal];
  }

  function runBivariateContrast(rows, overlay, varX, varY, cumulativeMTests = 1, pHistory = null, isConfirmatory = false) {
    const items = _getOverlayItems(overlay);
    const itemsById = {};
    for (const it of items) itemsById[it.id] = it;

    function extractSeries(varKey) {
      if (varKey.startsWith("DIM:")) {
        const dName = varKey.slice(4);
        const dimItems = items.filter((it) => it.dimension === dName && !it.exclude_from_psychometrics).map((it) => it.id);
        const vals = rows.map((r) => {
          const nums = dimItems.map((iid) => r[iid]).filter((v) => isFiniteNum(v));
          return nums.length ? _mean(nums) : null;
        });
        return [vals, true];
      }
      const itSpec = itemsById[varKey] || {};
      const sample = rows.slice(0, 20);
      const isNum = ["LIKERT_REFLECTIVA", "DICOTOMICA_CONOCIMIENTO", "CONOCIMIENTO_DICOTOMICA"].includes(itSpec.role) || (
        sample.every((r) => isFiniteNum(r[varKey]) || r[varKey] == null) && sample.some((r) => isFiniteNum(r[varKey]))
      );
      return [rows.map((r) => r[varKey]), isNum];
    }

    const [sx, xNum] = extractSeries(varX);
    const [sy, yNum] = extractSeries(varY);
    const paired = [];
    for (let i = 0; i < Math.min(sx.length, sy.length); i++) {
      if (sx[i] !== null && sx[i] !== undefined && sy[i] !== null && sy[i] !== undefined && String(sx[i]).trim() !== "" && String(sy[i]).trim() !== "") {
        paired.push([sx[i], sy[i]]);
      }
    }
    const n = paired.length;
    if (n < 4) return { applicable: false, reason: `Pares válidos insuficientes (N=${n} < 4).` };

    const res = { applicable: true, var_x: varX, var_y: varY, n, is_confirmatory: isConfirmatory };
    let pRaw = 1.0;

    if (xNum && yNum) {
      const xa = paired.map(([a]) => Number(a));
      const ya = paired.map(([, b]) => Number(b));
      const [rp, pp] = _pearsonAndP(xa, ya);
      const [rhos, ps] = _spearmanRhoAndP(xa, ya);
      const [slope, intercept] = _ols(xa, ya);
      const z = Math.atanh(Math.max(-0.9999, Math.min(0.9999, rp)));
      const se = 1.0 / Math.sqrt(Math.max(1, n - 3));
      const ciR = [roundTo(Math.tanh(z - 1.959964 * se), 6), roundTo(Math.tanh(z + 1.959964 * se), 6)];
      pRaw = pp;
      Object.assign(res, {
        test_family: "Correlación y Regresión Lineal (Escala x Escala)",
        pearson_r: roundTo(rp, 6),
        r_ci_95: ciR,
        r2: roundTo(rp * rp, 6),
        p_raw: pRaw,
        spearman_rho: roundTo(rhos, 6),
        spearman_p: ps,
        ols_slope: roundTo(slope, 6),
        ols_intercept: roundTo(intercept, 6),
        effect_size: { name: "r de Pearson", value: roundTo(rp, 6), ci_95: ciR },
      });
    } else if ((!xNum && yNum) || (xNum && !yNum)) {
      const groupsMap = {};
      for (const [a, b] of paired) {
        const c = !xNum ? String(a) : String(b);
        const nv = !xNum ? Number(b) : Number(a);
        if (!groupsMap[c]) groupsMap[c] = [];
        groupsMap[c].push(nv);
      }
      const validNames = Object.keys(groupsMap).filter((k) => groupsMap[k].length >= 2).sort();
      if (validNames.length < 2) return { applicable: false, reason: "Se requieren al menos 2 grupos con >=2 observaciones cada uno." };
      const gArrays = validNames.map((k) => groupsMap[k]);
      const groupSummaries = validNames.map((k) => ({
        group: k,
        n: groupsMap[k].length,
        mean: roundTo(_mean(groupsMap[k]), 4),
        sd: roundTo(_sd(groupsMap[k], 1), 4),
      }));

      if (gArrays.length === 2) {
        const [g1, g2] = gArrays;
        const [tStat, pt] = _welchT(g1, g2);
        const [uStat, pu] = _mannWhitneyU(g1, g2);
        const n1 = g1.length, n2 = g2.length;
        const sPool = Math.sqrt(((n1 - 1) * _variance(g1, 1) + (n2 - 1) * _variance(g2, 1)) / Math.max(1, n1 + n2 - 2));
        const dCohen = sPool > 0 ? (_mean(g1) - _mean(g2)) / sPool : 0.0;
        const seD = Math.sqrt((n1 + n2) / (n1 * n2) + (dCohen * dCohen) / (2.0 * (n1 + n2)));
        const ciD = [roundTo(dCohen - 1.959964 * seD, 6), roundTo(dCohen + 1.959964 * seD, 6)];
        pRaw = pt;
        Object.assign(res, {
          test_family: "Contraste de 2 Grupos (t de Welch + U de Mann-Whitney)",
          t_stat: roundTo(tStat, 6),
          p_raw: pRaw,
          mann_whitney_u: roundTo(uStat, 4),
          mann_whitney_p: pu,
          group_summaries: groupSummaries,
          effect_size: { name: "d de Cohen", value: roundTo(dCohen, 6), ci_95: ciD },
        });
      } else {
        const [fStat, pf, etaSq] = _oneWayAnova(gArrays);
        const [hStat, ph] = _kruskalWallis(gArrays);
        pRaw = pf;
        Object.assign(res, {
          test_family: `ANOVA de 1 Factor (${gArrays.length} grupos) + Kruskal-Wallis`,
          f_stat: roundTo(fStat, 6),
          df_between: gArrays.length - 1,
          df_within: n - gArrays.length,
          p_raw: pRaw,
          kruskal_h: roundTo(hStat, 6),
          kruskal_p: ph,
          group_summaries: groupSummaries,
          effect_size: { name: "Eta-cuadrado (η²)", value: roundTo(etaSq, 6), ci_95: [Math.max(0.0, roundTo(etaSq - 0.05, 6)), Math.min(1.0, roundTo(etaSq + 0.05, 6))] },
        });
      }
    } else {
      const xCats = Array.from(new Set(paired.map(([a]) => String(a)))).sort();
      const yCats = Array.from(new Set(paired.map(([, b]) => String(b)))).sort();
      if (xCats.length < 2 || yCats.length < 2) return { applicable: false, reason: "Se requieren >=2 categorías por variable para Chi-cuadrado." };
      const table = Array.from({ length: xCats.length }, () => new Array(yCats.length).fill(0));
      const xIdx = Object.fromEntries(xCats.map((c, i) => [c, i]));
      const yIdx = Object.fromEntries(yCats.map((c, j) => [c, j]));
      for (const [a, b] of paired) table[xIdx[String(a)]][yIdx[String(b)]]++;
      const rowSums = table.map((row) => row.reduce((u, v) => u + v, 0));
      const colSums = yCats.map((_, j) => table.reduce((u, row) => u + row[j], 0));
      let chi2 = 0;
      for (let i = 0; i < xCats.length; i++) {
        for (let j = 0; j < yCats.length; j++) {
          const exp = (rowSums[i] * colSums[j]) / n;
          if (exp > 0) chi2 += ((table[i][j] - exp) * (table[i][j] - exp)) / exp;
        }
      }
      const dof = (xCats.length - 1) * (yCats.length - 1);
      pRaw = chi2Sf(chi2, dof);
      const kMin = Math.min(xCats.length - 1, yCats.length - 1);
      const vCramer = Math.sqrt(chi2 / (n * Math.max(1, kMin)));
      Object.assign(res, {
        test_family: "Tabla de Contingencia (χ² de Pearson + V de Cramer)",
        chi2: roundTo(chi2, 6),
        df: dof,
        p_raw: pRaw,
        contingency_table: { rows: xCats, cols: yCats, counts: table },
        effect_size: { name: "V de Cramer", value: roundTo(vCramer, 6), ci_95: [Math.max(0.0, roundTo(vCramer - 0.06, 6)), Math.min(1.0, roundTo(vCramer + 0.06, 6))] },
      });
    }

    const pList = pHistory ? pHistory.slice() : [];
    pList.push(pRaw);
    const mEffective = Math.max(cumulativeMTests, pList.length);
    const pForAdj = pList.length < mEffective ? [...pList, ...new Array(mEffective - pList.length).fill(1.0)] : pList;
    const [holmAll, fdrAll] = applyHolmFdr(pForAdj);
    const pos = pList.length - 1;

    res.multiple_testing = {
      m_tests: mEffective,
      p_raw: roundTo(pRaw, 8),
      p_holm: holmAll[pos],
      q_fdr_bh: fdrAll[pos],
      significant_after_holm: holmAll[pos] < 0.05,
      significant_after_fdr: fdrAll[pos] < 0.05,
      warning_label: isConfirmatory ? "Prueba Confirmatoria Pre-registrada" : "Exploración Bivariada — Interpretación sujeta a corrección Holm/FDR",
    };
    return res;
  }

  function _runModelBundle(rows, overlay, labelMode) {
    const items = _getOverlayItems(overlay);
    const missingStrategy = (overlay && overlay.missing_strategy) || "pairwise";
    const likertItems = items.filter((it) => it.role === "LIKERT_REFLECTIVA");
    const binaryItems = items.filter((it) => it.role === "DICOTOMICA_CONOCIMIENTO" || it.role === "CONOCIMIENTO_DICOTOMICA");

    const scales = new Set(likertItems.map((it) => `${it.scale_min || 1}_${it.scale_max || 5}`));
    const useZ = scales.size > 1;

    const dims = {};
    for (const it of likertItems) {
      const d = it.dimension || "General";
      if (!dims[d]) dims[d] = [];
      dims[d].push(it);
    }

    const allLikertIds = likertItems.map((it) => it.id);
    let stage0 = {};
    if (allLikertIds.length >= 2 && rows.length > 0) {
      const matAll = _extractMatrix(rows, allLikertIds, useZ, missingStrategy);
      const smins = useZ ? new Array(allLikertIds.length).fill(-4.0) : likertItems.map((it) => Number(it.scale_min || 1));
      const smaxs = useZ ? new Array(allLikertIds.length).fill(4.0) : likertItems.map((it) => Number(it.scale_max || 5));
      stage0 = computePrerequisitesStage0(matAll, allLikertIds, smins, smaxs);
    }

    const dimReports = {};
    const cfaFactorIndices = {};
    const idToGlobal = Object.fromEntries(allLikertIds.map((iid, idx) => [iid, idx]));

    for (const [dimName, dItems] of Object.entries(dims)) {
      const dIds = dItems.map((it) => it.id);
      const k = dIds.length;
      if (k >= 3) {
        const matD = _extractMatrix(rows, dIds, useZ, missingStrategy);
        cfaFactorIndices[dimName] = dIds.map((i) => idToGlobal[i]);
        dimReports[dimName] = {
          n_items: k,
          items: dIds,
          mode: "Reflectiva >= 3 ítems (Alpha + Omega + CFA)",
          cronbach: computeCronbachAlpha(matD),
        };
      } else if (k === 2) {
        const matD = _extractMatrix(rows, dIds, useZ, missingStrategy);
        dimReports[dimName] = {
          n_items: 2,
          items: dIds,
          mode: "Subescala de 2 ítems (Spearman + Spearman-Brown)",
          spearman_brown: matD.length >= 4 ? computeSpearmanBrown2Items(matD.map((r) => r[0]), matD.map((r) => r[1])) : { applicable: false },
        };
      } else {
        dimReports[dimName] = {
          n_items: 1,
          items: dIds,
          mode: "Constructo de Ítem Único (Single-Item Construct)",
          note: "Inviable calcular consistencia interna con 1 ítem; analizar de forma descriptiva/individual.",
        };
      }
    }

    let globalAlpha = {};
    if (allLikertIds.length >= 3 && rows.length > 0) {
      globalAlpha = computeCronbachAlpha(_extractMatrix(rows, allLikertIds, useZ, missingStrategy));
    }

    let cfaRes = { applicable: false, reason: "No hay dimensiones reflectivas con >= 3 ítems." };
    if (Object.keys(cfaFactorIndices).length > 0 && rows.length > 0) {
      const cfaItemIds = [];
      const remapped = {};
      for (const [fName, dItems] of Object.entries(dims)) {
        if (dItems.length >= 3) {
          const startI = cfaItemIds.length;
          for (const it of dItems) cfaItemIds.push(it.id);
          remapped[fName] = Array.from({ length: cfaItemIds.length - startI }, (_, o) => startI + o);
        }
      }
      const matCfa = _extractMatrix(rows, cfaItemIds, useZ, missingStrategy);
      const completeCfa = _completeRowsMatrix(matCfa);
      if (completeCfa.length > cfaItemIds.length) {
        const Rcfa = _corrMatrix(completeCfa);
        cfaRes = computeCfaMl(Rcfa, completeCfa.length, remapped, cfaItemIds);
      } else {
        cfaRes = { applicable: false, reason: `Casos completos insuficientes (N=${completeCfa.length} <= p=${cfaItemIds.length}).` };
      }
    }

    let kr20Res = { applicable: false };
    if (binaryItems.length >= 2 && rows.length > 0) {
      const bIds = binaryItems.map((it) => it.id);
      kr20Res = computeKr20(_extractMatrix(rows, bIds, false, missingStrategy));
    }

    return {
      mode_label: labelMode,
      n_rows: rows.length,
      mixed_scales_z_applied: useZ,
      stage0_prerequisites: stage0,
      dimensions: dimReports,
      global_alpha: globalAlpha,
      cfa: cfaRes,
      kr20: kr20Res,
    };
  }

  function _describeAllQuestions(rows, overlay) {
    const items = _getOverlayItems(overlay);
    const nRows = rows.length;
    return items.map((it) => {
      const iid = it.id;
      const role = it.role || "LIKERT_REFLECTIVA";
      const vals = rows.map((r) => r[iid]);
      const rawVals = rows.map((r) => (r[`${iid}_raw`] !== undefined ? r[`${iid}_raw`] : r[iid]));
      const nonNull = vals.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
      const nValid = nonNull.length;

      const freqCounts = {};
      for (const rv of rawVals) {
        const lbl = rv === null || rv === undefined || String(rv).trim() === "" ? "(Sin respuesta)" : String(rv).trim();
        freqCounts[lbl] = (freqCounts[lbl] || 0) + 1;
      }

      let cumPct = 0.0;
      const freqTable = Object.entries(freqCounts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([lbl, cnt]) => {
          const pct = nRows > 0 ? (cnt / nRows) * 100.0 : 0.0;
          const validPct = nValid > 0 && lbl !== "(Sin respuesta)" ? (cnt / nValid) * 100.0 : 0.0;
          if (lbl !== "(Sin respuesta)") cumPct += validPct;
          return {
            label: lbl,
            count: cnt,
            pct: roundTo(pct, 2),
            valid_pct: roundTo(validPct, 2),
            cumulative_pct: roundTo(Math.min(100.0, cumPct), 2),
          };
        });

      const statsObj = { n_total: nRows, n_valid: nValid, n_missing: nRows - nValid };
      const numVals = nonNull.filter((v) => isFiniteNum(v));
      if ((role === "LIKERT_REFLECTIVA" || role === "ORDINAL_SINGLE_ITEM") && numVals.length >= 1) {
        const smin = Number(it.scale_min || 1);
        const smax = Number(it.scale_max || 5);
        const top2 = smax >= 4 ? smax - 1.0 : smax;
        const sorted = numVals.slice().sort((a, b) => a - b);
        Object.assign(statsObj, {
          mean: roundTo(_mean(numVals), 4),
          sd: roundTo(numVals.length > 1 ? _sd(numVals, 1) : 0.0, 4),
          median: roundTo(_percentileLinear(sorted, 50), 4),
          iqr: roundTo(_percentileLinear(sorted, 75) - _percentileLinear(sorted, 25), 4),
          top2box_pct: roundTo((numVals.filter((v) => v >= top2).length / numVals.length) * 100.0, 2),
          bottom2box_pct: roundTo((numVals.filter((v) => v <= smin + 1.0).length / numVals.length) * 100.0, 2),
          pct_floor: roundTo((numVals.filter((v) => v <= smin + 1e-9).length / numVals.length) * 100.0, 2),
          pct_ceiling: roundTo((numVals.filter((v) => v >= smax - 1e-9).length / numVals.length) * 100.0, 2),
        });
      } else if ((role === "DICOTOMICA_CONOCIMIENTO" || role === "CONOCIMIENTO_DICOTOMICA") && numVals.length >= 1) {
        const m = _mean(numVals);
        Object.assign(statsObj, {
          correct_pct: roundTo(m * 100.0, 2),
          incorrect_pct: roundTo((1.0 - m) * 100.0, 2),
        });
      }

      return {
        id: iid,
        text: it.text || iid,
        role,
        dimension: it.dimension || "General",
        is_reverse: Boolean(it.is_reverse),
        exclude_from_psychometrics: ["SOCIODEMOGRAFICA_FILTRO", "ORDINAL_SINGLE_ITEM", "SELECCION_MULTIPLE", "ABIERTA_CUALITATIVA"].includes(role),
        frequency_table: freqTable,
        descriptives: statsObj,
      };
    });
  }

  function runFullAnalysis(rows, overlay, originalOverlay = null) {
    const transformed = applyOverlayTransforms(rows, overlay);
    const tRows = transformed.rows;
    const quality = auditSampleQuality(tRows, overlay);

    let confirmatoryBundle;
    if (originalOverlay && overlay && overlay.is_posthoc_exploratory) {
      const origT = applyOverlayTransforms(rows, originalOverlay).rows;
      confirmatoryBundle = _runModelBundle(origT, originalOverlay, "Muestra Completa / Estructura Original (Confirmatorio)");
    } else {
      confirmatoryBundle = _runModelBundle(tRows, overlay, "Muestra Completa / Estructura Base (Confirmatorio)");
    }

    const exclSl = new Set(
      overlay && overlay.exclude_straight_lining
        ? [...quality.straight_lining_indices, ...quality.incongruent_indices]
        : []
    );
    const exclOut = new Set(overlay && overlay.exclude_mahalanobis_outliers ? quality.outlier_indices : []);
    const excludedAll = new Set([...exclSl, ...exclOut]);
    const activeRows = tRows.filter((_, i) => !excludedAll.has(i));

    const isModified = excludedAll.size > 0 || Boolean(overlay && overlay.is_posthoc_exploratory);
    const exploratoryBundle = isModified
      ? _runModelBundle(activeRows, overlay, "Análisis Post-Hoc de Carácter Exploratorio (Muestra Saneada / Modelo Re-especificado)")
      : null;

    return {
      group_id: overlay && overlay.group_id,
      n_total: tRows.length,
      n_active: activeRows.length,
      n_excluded_whatif: excludedAll.size,
      scrubbed_pii_columns: transformed.scrubbed_pii_columns,
      timestamps: transformed.timestamps,
      causal_traces: transformed.causal_traces,
      sample_quality: quality,
      questions_100: _describeAllQuestions(activeRows, overlay),
      dual_report: {
        is_exploratory_active: isModified,
        exploratory_stamp: isModified ? "Análisis Post-Hoc de Carácter Exploratorio" : null,
        confirmatory: confirmatoryBundle,
        exploratory: exploratoryBundle,
      },
    };
  }

  function evaluateArenaRegroupingTournament(rows, overlay, candidateProposals) {
    const results = (candidateProposals || []).map((prop) => {
      const mapping = prop.mapping || {};
      const testOverlay = cloneJson(overlay);
      testOverlay.is_posthoc_exploratory = true;
      const itemToNewDim = {};
      for (const [dimName, ids] of Object.entries(mapping)) {
        for (const iid of ids) itemToNewDim[iid] = dimName;
      }
      const items = _getOverlayItems(testOverlay).map((it) => {
        const cp = Object.assign({}, it);
        if (itemToNewDim[cp.id]) {
          cp.dimension = itemToNewDim[cp.id];
          cp.role = "LIKERT_REFLECTIVA";
        }
        return cp;
      });
      testOverlay.items = items;

      const tRows = applyOverlayTransforms(rows, testOverlay).rows;
      const bundle = _runModelBundle(tRows, testOverlay, "Propuesta Consultiva Exploratoria");
      const cfa = bundle.cfa || {};
      return {
        proposal_id: prop.id,
        title: prop.title,
        theory_rationale: prop.theory,
        advisory_disclaimer: "Propuesta consultiva — requiere justificación teórica y aprobación final del equipo investigador.",
        stamp: "Análisis Post-Hoc de Carácter Exploratorio",
        bic: cfa.applicable ? cfa.bic : 1e12,
        aic: cfa.applicable ? cfa.aic : 1e12,
        cfi: cfa.applicable ? cfa.cfi : 0.0,
        cfa_applicable: Boolean(cfa.applicable),
        dimensions_summary: bundle.dimensions,
        cfa_summary: cfa,
        mapping,
      };
    });
    results.sort((a, b) => ((a.cfa_applicable ? 0 : 1) - (b.cfa_applicable ? 0 : 1)) || (a.bic - b.bic) || (b.cfi - a.cfi));
    return results;
  }

  function generateReproducibilityScripts(overlay) {
    const gid = (overlay && overlay.group_id) || "G1";
    const items = _getOverlayItems(overlay);
    const likert = items.filter((it) => it.role === "LIKERT_REFLECTIVA");
    const binary = items.filter((it) => it.role === "DICOTOMICA_CONOCIMIENTO" || it.role === "CONOCIMIENTO_DICOTOMICA");
    const reverses = likert.filter((it) => it.is_reverse).map((it) => it.id);

    const dims = {};
    for (const it of likert) {
      const d = it.dimension || "General";
      if (!dims[d]) dims[d] = [];
      dims[d].push(it.id);
    }

    const rLines = [
      `# Script Reproducible R (psych + lavaan + semTools) — ${gid}`,
      `# Estado: ${overlay && overlay.is_posthoc_exploratory ? "Análisis Post-Hoc Exploratorio" : "Modelo Confirmatorio"}`,
      "library(psych)", "library(lavaan)", "library(semTools)", "",
      `df <- read.csv('matriz_limpia_${gid}.csv', stringsAsFactors = FALSE)`, "",
    ];
    if (reverses.length) {
      rLines.push("# 2. Recodificación de ítems inversos declarados");
      for (const rid of reverses) {
        const itObj = likert.find((x) => x.id === rid);
        const sSum = Number(itObj.scale_min || 1) + Number(itObj.scale_max || 5);
        rLines.push(`df$${rid} <- ${sSum} - df$${rid}`);
      }
      rLines.push("");
    }
    if (likert.length) {
      const colsVec = likert.map((it) => `'${it.id}'`).join(", ");
      rLines.push(`mat_likert <- df[, c(${colsVec})]`, "describe(mat_likert)", "mardia(mat_likert)", "KMO(mat_likert)");
      rLines.push("cortest.bartlett(cor(mat_likert, use='pairwise.complete.obs'), n=nrow(mat_likert))", "");
      for (const [dname, dids] of Object.entries(dims)) {
        if (dids.length >= 3) {
          const dVec = dids.map((i) => `'${i}'`).join(", ");
          rLines.push(`psych::alpha(df[, c(${dVec})])  # ${dname}`);
          rLines.push(`psych::omega(df[, c(${dVec})], nfactors=1)  # ${dname}`);
        } else if (dids.length === 2) {
          rLines.push(`cor.test(df$${dids[0]}, df$${dids[1]}, method='spearman')  # 2 ítems: ${dname}`);
        }
      }
      const cfaDims = Object.entries(dims).filter(([, v]) => v.length >= 3);
      if (cfaDims.length) {
        rLines.push("", "modelo_cfa <- '");
        for (const [dname, dids] of cfaDims) {
          const safeF = dname.replace(/[^A-Za-z0-9_]/g, "_");
          rLines.push(`  ${safeF} =~ ${dids.join(" + ")}`);
        }
        rLines.push("'", "fit <- cfa(modelo_cfa, data = df, std.lv = TRUE, estimator = 'ML')", "summary(fit, fit.measures = TRUE, standardized = TRUE)", "semTools::htmt(modelo_cfa, data = df)");
      }
    }
    if (binary.length) {
      const bVec = binary.map((it) => `'${it.id}'`).join(", ");
      rLines.push("", `psych::alpha(df[, c(${bVec})])  # KR-20`);
    }

    const spssLines = [`* Sintaxis Reproducible SPSS — ${gid}.`];
    for (const rid of reverses) spssLines.push(`RECODE ${rid} (1=5) (2=4) (3=3) (4=2) (5=1).`);
    spssLines.push("EXECUTE.");
    for (const [dname, dids] of Object.entries(dims)) {
      if (dids.length >= 2) spssLines.push(`RELIABILITY /VARIABLES=${dids.join(" ")} /SCALE('${dname}') ALL /MODEL=ALPHA /STATISTICS=DESCRIPTIVE SCALE CORR /SUMMARY=TOTAL.`);
    }
    if (likert.length >= 3) {
      spssLines.push(`FACTOR /VARIABLES=${likert.map((i) => i.id).join(" ")} /PRINT=INITIAL KMO EXTRACTION ROTATION /CRITERIA=MINEIGEN(1) /EXTRACTION=PAF.`);
    }

    return { r_script: rLines.join("\n"), spss_syntax: spssLines.join("\n") };
  }

  return {
    MIN_ITEMS_PER_FACTOR,
    FLOOR_CEILING_THRESHOLD,
    HTMT_STRICT_THRESHOLD,
    scrubPiiRows,
    parseAndNormalizeDate,
    applyOverlayTransforms,
    computeCronbachAlpha,
    computeKr20,
    computeSpearmanBrown2Items,
    computePrerequisitesStage0,
    computeHtmtMatrix,
    computeCfaMl,
    auditSampleQuality,
    computeAikenV,
    checkPrefieldIdentifiability,
    applyHolmFdr,
    runBivariateContrast,
    runFullAnalysis,
    evaluateArenaRegroupingTournament,
    generateReproducibilityScripts,
  };
});
