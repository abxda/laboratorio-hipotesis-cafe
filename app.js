(() => {
  "use strict";

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const chart = $("#chart");
  const testCanvas = $("#testCanvas");
  const miniTestCanvas = $("#miniTestCanvas");
  const ciRainCanvas = $("#ciRainCanvas");
  const standardizeCanvas = $("#standardizeCanvas");
  const chartContext = chart.getContext("2d");
  const testContext = testCanvas.getContext("2d");
  const miniTestContext = miniTestCanvas.getContext("2d");
  const ciRainContext = ciRainCanvas.getContext("2d");
  const standardizeContext = standardizeCanvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const controls = {
    mu: $("#mu"),
    sigma: $("#sigma"),
    n: $("#n"),
    shape: $("#shapeSelect"),
    confidence: $("#confidenceSelect"),
    alpha: $("#alphaSelect"),
  };

  const state = {
    currentStep: 1,
    running: false,
    timer: null,
    sampleCount: 0,
    sampleRun: 0,
    distribution: "skew",
    direction: "two",
    observed: [],
    observedMean: 500,
    samplingMeans: [],
    recentMeans: [],
    animSample: null,
    stdAnim: null,
  };

  const ciState = { rows: [], total: 0, captured: 0, timer: null };

  function randn() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function standardizedObservation(shape = state.distribution) {
    if (shape === "normal") return randn();
    if (shape === "uniform") return (Math.random() - 0.5) * Math.sqrt(12);
    if (shape === "bimodal") {
      const component = Math.random() < 0.5 ? -0.9 : 0.9;
      return (component + randn() * 0.36) / Math.sqrt(0.9 ** 2 + 0.36 ** 2);
    }
    return -Math.log(Math.max(Math.random(), 1e-12)) - 1;
  }

  function populationObservation() {
    return +controls.mu.value + +controls.sigma.value * standardizedObservation();
  }

  function sampleMean() {
    const count = +controls.n.value;
    let total = 0;
    for (let index = 0; index < count; index += 1) total += populationObservation();
    return total / count;
  }

  function erf(value) {
    const sign = value < 0 ? -1 : 1;
    const x = Math.abs(value);
    const t = 1 / (1 + 0.3275911 * x);
    const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
    return sign * (1 - polynomial * Math.exp(-x * x));
  }

  const normalCdf = (value) => 0.5 * (1 + erf(value / Math.sqrt(2)));

  function oneTailCritical(alpha) {
    const lookup = { "0.1": 1.2816, "0.05": 1.6449, "0.01": 2.3263 };
    return lookup[String(alpha)] ?? 1.6449;
  }

  function twoTailCritical(alpha) {
    const lookup = { "0.1": 1.6449, "0.05": 1.96, "0.01": 2.5758 };
    return lookup[String(alpha)] ?? 1.96;
  }

  function confidenceCritical(level) {
    const lookup = { "0.9": 1.6449, "0.95": 1.96, "0.99": 2.5758 };
    return lookup[String(level)] ?? 1.96;
  }

  function calculateStatistics() {
    const sigma = +controls.sigma.value;
    const n = +controls.n.value;
    const xbar = state.observedMean;
    const mu0 = 500;
    const se = sigma / Math.sqrt(n);
    const z = (xbar - mu0) / se;
    const alpha = +controls.alpha.value;
    let p;
    let critical;
    if (state.direction === "two") {
      p = 2 * (1 - normalCdf(Math.abs(z)));
      critical = twoTailCritical(alpha);
    } else if (state.direction === "left") {
      p = normalCdf(z);
      critical = -oneTailCritical(alpha);
    } else {
      p = 1 - normalCdf(z);
      critical = oneTailCritical(alpha);
    }
    const reject = p < alpha;
    const confidence = +controls.confidence.value;
    const ciCritical = confidenceCritical(confidence);
    const margin = ciCritical * se;
    return {
      sigma, n, xbar, mu0, se, z,
      p: clamp(p, 0, 1),
      alpha, critical, reject,
      confidence, ciCritical, margin,
      low: xbar - margin,
      high: xbar + margin,
    };
  }

  function populationDensity(z) {
    if (state.distribution === "normal") return Math.exp(-0.5 * z * z);
    if (state.distribution === "uniform") return Math.abs(z) <= Math.sqrt(3) ? 0.72 : 0;
    if (state.distribution === "bimodal") {
      const scale = Math.sqrt(0.9 ** 2 + 0.36 ** 2);
      const sd = 0.36 / scale;
      const location = 0.9 / scale;
      return 0.5 * Math.exp(-0.5 * ((z - location) / sd) ** 2) + 0.5 * Math.exp(-0.5 * ((z + location) / sd) ** 2);
    }
    return z >= -1 ? Math.exp(-(z + 1)) : 0;
  }

  function prepareCanvas(canvasElement, context) {
    const rect = canvasElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasElement.width = Math.max(1, Math.floor(rect.width * dpr));
    canvasElement.height = Math.max(1, Math.floor(rect.height * dpr));
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width: rect.width, height: rect.height };
  }

  const easeOut = (p) => 1 - (1 - p) ** 3;

  // ---- Gráfica principal: población arriba, medias abajo, animación de una muestra ----

  const ANIM_FALL = 900;
  const ANIM_MERGE = 800;
  const ANIM_DROP = 600;
  const ANIM_TOTAL = ANIM_FALL + ANIM_MERGE + ANIM_DROP;

  function drawMainChart() {
    const { width, height } = prepareCanvas(chart, chartContext);
    if (!width || !height) return;
    const ctx = chartContext;
    const mu = +controls.mu.value;
    const sigma = +controls.sigma.value;
    const n = +controls.n.value;
    const se = sigma / Math.sqrt(n);
    const spread = Math.max(22, sigma * 3.4);
    const xMin = mu - spread;
    const xMax = mu + spread;
    const padding = { left: 48, right: 22, top: 54, bottom: 43 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const topBase = padding.top + plotHeight * 0.35;
    const bottomBase = height - padding.bottom;
    const xPosition = (value) => padding.left + ((value - xMin) / (xMax - xMin)) * plotWidth;

    ctx.clearRect(0, 0, width, height);
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = "#173c32";
    ctx.strokeStyle = "rgba(23,60,50,.16)";
    ctx.lineWidth = 1;
    for (let index = 0; index <= 4; index += 1) {
      const value = xMin + (index / 4) * (xMax - xMin);
      const x = xPosition(value);
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, bottomBase);
      ctx.stroke();
      ctx.fillText(`${value.toFixed(0)} g`, x, height - 17);
    }

    const populationBins = 52;
    const densityValues = [];
    let maxDensity = 0;
    for (let index = 0; index < populationBins; index += 1) {
      const value = xMin + ((index + 0.5) / populationBins) * (xMax - xMin);
      const density = populationDensity((value - mu) / sigma);
      densityValues.push(density);
      maxDensity = Math.max(maxDensity, density);
    }
    densityValues.forEach((density, index) => {
      const barHeight = maxDensity ? (density / maxDensity) * plotHeight * 0.23 : 0;
      ctx.fillStyle = index % 3 === 0 ? "#8b5130" : "#6d3d25";
      ctx.globalAlpha = 0.84;
      ctx.fillRect(padding.left + index * plotWidth / populationBins + 1, topBase - barHeight, plotWidth / populationBins - 2, barHeight);
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#2e5c4c";
    ctx.textAlign = "left";
    ctx.font = "700 10px ui-sans-serif, system-ui";
    ctx.fillText("POBLACIÓN · UNA BOLSA PUEDE TENER UNA FORMA NO NORMAL", padding.left, topBase + 21);

    const histogramBins = 54;
    const counts = Array(histogramBins).fill(0);
    state.samplingMeans.forEach((mean) => {
      const bin = Math.floor(((mean - xMin) / (xMax - xMin)) * histogramBins);
      if (bin >= 0 && bin < histogramBins) counts[bin] += 1;
    });
    const maxCount = Math.max(1, ...counts);
    counts.forEach((count, index) => {
      const barHeight = (count / maxCount) * plotHeight * 0.42;
      ctx.fillStyle = "#6d3d25";
      ctx.globalAlpha = 0.9;
      ctx.fillRect(padding.left + index * plotWidth / histogramBins + 1, bottomBase - barHeight, plotWidth / histogramBins - 2, barHeight);
    });
    ctx.globalAlpha = 1;

    ctx.beginPath();
    for (let pixel = 0; pixel <= plotWidth; pixel += 2) {
      const value = xMin + (pixel / plotWidth) * (xMax - xMin);
      const density = Math.exp(-0.5 * ((value - mu) / se) ** 2);
      const y = bottomBase - density * plotHeight * 0.42;
      if (pixel === 0) ctx.moveTo(xPosition(value), y);
      else ctx.lineTo(xPosition(value), y);
    }
    ctx.strokeStyle = "#bd3a2f";
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = "#2e5c4c";
    ctx.font = "700 10px ui-sans-serif, system-ui";
    ctx.fillText(`MEDIAS DE n = ${n} · ERROR ESTÁNDAR σ/√n = ${se.toFixed(2)} g`, padding.left, bottomBase - plotHeight * 0.47);
    ctx.strokeStyle = "#e8a91e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xPosition(mu), padding.top);
    ctx.lineTo(xPosition(mu), bottomBase);
    ctx.stroke();
    ctx.fillStyle = "#173c32";
    ctx.fillText(`μ real = ${mu.toFixed(0)} g`, xPosition(mu) + 6, padding.top + 15);

    state.recentMeans.forEach((mean, index) => {
      const age = index / Math.max(1, state.recentMeans.length - 1);
      const y = bottomBase - plotHeight * 0.43 - 12 - age * 34;
      ctx.beginPath();
      ctx.arc(xPosition(mean), y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#e8a91e";
      ctx.globalAlpha = 0.35 + age * 0.65;
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    if (state.animSample) {
      const { values, mean, t0 } = state.animSample;
      const elapsed = performance.now() - t0;
      const stripY = topBase + 48;
      const meanX = xPosition(clamp(mean, xMin, xMax));

      if (elapsed < ANIM_FALL + ANIM_MERGE) {
        values.forEach((value, index) => {
          const delay = (index / values.length) * 380;
          const fall = clamp((elapsed - delay) / 480, 0, 1);
          if (fall <= 0) return;
          let x = clamp(value, xMin, xMax);
          let y = (padding.top + 8) + (stripY - padding.top - 8) * easeOut(fall);
          if (elapsed > ANIM_FALL) {
            const merge = easeOut(clamp((elapsed - ANIM_FALL) / ANIM_MERGE, 0, 1));
            x = x + (clamp(mean, xMin, xMax) - x) * merge;
            y = stripY;
          }
          ctx.beginPath();
          ctx.arc(xPosition(x), y, 3.2, 0, Math.PI * 2);
          ctx.fillStyle = "#e8a91e";
          ctx.strokeStyle = "#6d3d25";
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
        });
        ctx.fillStyle = "#6d3d25";
        ctx.font = "800 11px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(
          elapsed <= ANIM_FALL
            ? `1) caen las ${values.length} bolsas de la muestra…`
            : `2) las promediamos → x̄ = ${mean.toFixed(1)} g`,
          padding.left + plotWidth / 2,
          stripY - 16,
        );
      } else {
        const drop = easeOut(clamp((elapsed - ANIM_FALL - ANIM_MERGE) / ANIM_DROP, 0, 1));
        const y = stripY + (bottomBase - 8 - stripY) * drop;
        ctx.beginPath();
        ctx.arc(meanX, y, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = "#e8a91e";
        ctx.strokeStyle = "#6d3d25";
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#6d3d25";
        ctx.font = "800 11px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(`3) x̄ = ${mean.toFixed(1)} g cae al histograma de medias`, padding.left + plotWidth / 2, stripY - 16);
      }
      ctx.textAlign = "left";
    }
  }

  function startOneSampleAnim() {
    if (state.animSample) return;
    if (state.running) setSampling(false);
    const n = +controls.n.value;
    const values = Array.from({ length: n }, populationObservation);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (reduceMotion) {
      commitMeans([mean]);
      return;
    }
    state.animSample = { values, mean, t0: performance.now() };
    $("#oneSampleBtn").disabled = true;
    requestAnimationFrame(oneSampleFrame);
  }

  function oneSampleFrame() {
    if (!state.animSample) return;
    const elapsed = performance.now() - state.animSample.t0;
    if (elapsed >= ANIM_TOTAL) {
      const { mean } = state.animSample;
      state.animSample = null;
      $("#oneSampleBtn").disabled = false;
      commitMeans([mean]);
      return;
    }
    drawMainChart();
    requestAnimationFrame(oneSampleFrame);
  }

  function commitMeans(means) {
    state.samplingMeans.push(...means);
    if (state.samplingMeans.length > 4000) state.samplingMeans.splice(0, state.samplingMeans.length - 4000);
    state.recentMeans = [...means.slice(-12), ...state.recentMeans].slice(0, 24);
    state.sampleCount += means.length;
    $("#count").textContent = state.sampleCount.toLocaleString("es-MX");
    updateEmpirical();
    drawMainChart();
  }

  function updateEmpirical() {
    const mu = +controls.mu.value;
    const se = +controls.sigma.value / Math.sqrt(+controls.n.value);
    $("#theoryMu").textContent = mu.toFixed(1);
    $("#theorySe").textContent = se.toFixed(2);
    const means = state.samplingMeans;
    if (means.length < 2) {
      $("#empMu").textContent = "—";
      $("#empSe").textContent = "—";
      return;
    }
    const mean = means.reduce((sum, value) => sum + value, 0) / means.length;
    const variance = means.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (means.length - 1);
    $("#empMu").textContent = `${mean.toFixed(1)} g`;
    $("#empSe").textContent = `${Math.sqrt(variance).toFixed(2)} g`;
  }

  // ---- Curva z de la prueba (versión grande del paso 4 y mini del panel 03) ----

  function shadeUnderCurve(ctx, xPosition, yPosition, from, to, color, step = 0.035) {
    ctx.beginPath();
    ctx.moveTo(xPosition(from), yPosition(0));
    for (let z = from; z <= to; z += step) ctx.lineTo(xPosition(z), yPosition(Math.exp(-0.5 * z * z)));
    ctx.lineTo(xPosition(to), yPosition(0));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  function drawTestChart(stats = calculateStatistics(), canvasEl = testCanvas, context = testContext, compact = false) {
    const { width, height } = prepareCanvas(canvasEl, context);
    if (!width || !height) return;
    const ctx = context;
    const padding = compact
      ? { left: 10, right: 10, top: 26, bottom: 24 }
      : { left: 42, right: 28, top: 35, bottom: 42 };
    const plotWidth = width - padding.left - padding.right;
    const baseline = height - padding.bottom;
    const amplitude = height - padding.top - padding.bottom;
    const xPosition = (z) => padding.left + ((z + 4) / 8) * plotWidth;
    const yPosition = (density) => baseline - density * amplitude * 0.98;
    ctx.clearRect(0, 0, width, height);

    const criticalMagnitude = Math.abs(stats.critical);
    if (state.direction === "two") {
      shadeUnderCurve(ctx, xPosition, yPosition, -4, -criticalMagnitude, "rgba(189,58,47,.24)");
      shadeUnderCurve(ctx, xPosition, yPosition, criticalMagnitude, 4, "rgba(189,58,47,.24)");
    } else if (state.direction === "left") {
      shadeUnderCurve(ctx, xPosition, yPosition, -4, stats.critical, "rgba(189,58,47,.24)");
    } else {
      shadeUnderCurve(ctx, xPosition, yPosition, stats.critical, 4, "rgba(189,58,47,.24)");
    }

    const observedMagnitude = Math.min(4, Math.abs(stats.z));
    if (state.direction === "two") {
      shadeUnderCurve(ctx, xPosition, yPosition, -4, -observedMagnitude, "rgba(232,169,30,.5)");
      shadeUnderCurve(ctx, xPosition, yPosition, observedMagnitude, 4, "rgba(232,169,30,.5)");
    } else if (state.direction === "left") {
      shadeUnderCurve(ctx, xPosition, yPosition, -4, clamp(stats.z, -4, 4), "rgba(232,169,30,.5)");
    } else {
      shadeUnderCurve(ctx, xPosition, yPosition, clamp(stats.z, -4, 4), 4, "rgba(232,169,30,.5)");
    }

    ctx.beginPath();
    for (let z = -4; z <= 4; z += 0.03) {
      const density = Math.exp(-0.5 * z * z);
      if (z === -4) ctx.moveTo(xPosition(z), yPosition(density));
      else ctx.lineTo(xPosition(z), yPosition(density));
    }
    ctx.strokeStyle = "#173c32";
    ctx.lineWidth = compact ? 2 : 3;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, baseline);
    ctx.lineTo(width - padding.right, baseline);
    ctx.stroke();

    ctx.fillStyle = "#173c32";
    ctx.font = compact ? "9px ui-monospace, monospace" : "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    for (let tick = -4; tick <= 4; tick += compact ? 2 : 1) {
      ctx.fillText(String(tick), xPosition(tick), baseline + (compact ? 14 : 20));
    }
    const observedX = xPosition(clamp(stats.z, -4, 4));
    ctx.strokeStyle = "#6d3d25";
    ctx.lineWidth = compact ? 2 : 3;
    ctx.beginPath();
    ctx.moveTo(observedX, padding.top + (compact ? 8 : 12));
    ctx.lineTo(observedX, baseline);
    ctx.stroke();
    ctx.fillStyle = "#6d3d25";
    ctx.font = compact ? "800 10px ui-monospace, monospace" : "800 11px ui-monospace, monospace";
    ctx.fillText(`z = ${stats.z.toFixed(2)}`, clamp(observedX, padding.left + 26, width - padding.right - 26), padding.top + 2);

    ctx.fillStyle = "#2e5c4c";
    ctx.textAlign = "left";
    ctx.font = compact ? "700 8px ui-sans-serif, system-ui" : "700 10px ui-sans-serif, system-ui";
    ctx.fillText(compact ? "CURVA z SI H₀ ES CIERTA · ROJO = ZONA CRÍTICA" : "DISTRIBUCIÓN DE z SI H₀: μ = 500 g ES CIERTA", padding.left, compact ? 12 : 17);
  }

  // ---- Lluvia de intervalos de confianza ----

  function addCiInterval() {
    const mu = +controls.mu.value;
    const sigma = +controls.sigma.value;
    const n = +controls.n.value;
    const se = sigma / Math.sqrt(n);
    const margin = confidenceCritical(+controls.confidence.value) * se;
    const mean = sampleMean();
    const captured = Math.abs(mean - mu) <= margin;
    ciState.rows.push({ mean, margin, captured });
    if (ciState.rows.length > 60) ciState.rows.shift();
    ciState.total += 1;
    if (captured) ciState.captured += 1;
    drawCiRain();
    updateCiTally();
  }

  function simulateCiBatch(count = 60) {
    if (ciState.timer) return;
    if (reduceMotion) {
      for (let index = 0; index < count; index += 1) addCiInterval();
      return;
    }
    let added = 0;
    $("#ciRainBtn").disabled = true;
    ciState.timer = window.setInterval(() => {
      addCiInterval();
      added += 1;
      if (added >= count) {
        clearInterval(ciState.timer);
        ciState.timer = null;
        $("#ciRainBtn").disabled = false;
      }
    }, 24);
  }

  function resetCiRain() {
    clearInterval(ciState.timer);
    ciState.timer = null;
    ciState.rows = [];
    ciState.total = 0;
    ciState.captured = 0;
    const button = $("#ciRainBtn");
    if (button) button.disabled = false;
    $("#ciRainTally").textContent = "Aún no hay intervalos. Pulsa el botón y observa qué fracción atrapa a μ.";
    drawCiRain();
  }

  function drawCiRain() {
    const { width, height } = prepareCanvas(ciRainCanvas, ciRainContext);
    if (!width || !height) return;
    const ctx = ciRainContext;
    const mu = +controls.mu.value;
    const sigma = +controls.sigma.value;
    const n = +controls.n.value;
    const se = sigma / Math.sqrt(n);
    const margin = confidenceCritical(+controls.confidence.value) * se;
    const half = Math.max(4.6 * se, margin * 1.3);
    const xMin = mu - half;
    const xMax = mu + half;
    const pad = { left: 16, right: 16, top: 26, bottom: 10 };
    const X = (value) => pad.left + ((clamp(value, xMin, xMax) - xMin) / (xMax - xMin)) * (width - pad.left - pad.right);
    ctx.clearRect(0, 0, width, height);

    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "#bd3a2f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(X(mu), pad.top - 8);
    ctx.lineTo(X(mu), height - pad.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#bd3a2f";
    ctx.font = "800 10px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(`μ real = ${mu} g`, X(mu) + 7, 13);

    const rowHeight = (height - pad.top - pad.bottom) / 60;
    ciState.rows.forEach((row, index) => {
      const y = pad.top + index * rowHeight + rowHeight / 2;
      ctx.strokeStyle = row.captured ? "rgba(46,125,79,.8)" : "#bd3a2f";
      ctx.lineWidth = row.captured ? 1.6 : 2.6;
      ctx.beginPath();
      ctx.moveTo(X(row.mean - row.margin), y);
      ctx.lineTo(X(row.mean + row.margin), y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(X(row.mean), y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = "#6d3d25";
      ctx.fill();
    });

    if (!ciState.rows.length) {
      ctx.fillStyle = "#2e5c4c";
      ctx.font = "italic 13px Georgia, serif";
      ctx.textAlign = "center";
      ctx.fillText("Cada muestra nueva produce un intervalo distinto…", width / 2, height / 2);
    }
    ctx.textAlign = "left";
  }

  function updateCiTally() {
    if (!ciState.total) return;
    const percent = ((ciState.captured / ciState.total) * 100).toFixed(1);
    const confidence = (+controls.confidence.value * 100).toFixed(0);
    $("#ciRainTally").textContent = `${ciState.captured} de ${ciState.total} intervalos atrapan a μ (${percent}%). A la larga se espera ≈ ${confidence}%.`;
  }

  // ---- Animación de estandarización: gramos → desviación → z ----

  const STD_DURATION = 1900;

  function drawStandardize() {
    const { width, height } = prepareCanvas(standardizeCanvas, standardizeContext);
    if (!width || !height) return;
    const ctx = standardizeContext;
    const stats = calculateStatistics();
    const left = Math.min(190, width * 0.28);
    const right = 26;
    const zSpan = 4;
    const ZX = (z) => left + ((clamp(z, -zSpan, zSpan) + zSpan) / (2 * zSpan)) * (width - left - right);
    const zObs = clamp(stats.z, -3.85, 3.85);
    const dotX = ZX(zObs);
    const rows = [
      { y: 54, title: "1 · x̄ en gramos", tick: (z) => (stats.mu0 + z * stats.se).toFixed(1), valueLabel: `x̄ = ${stats.xbar.toFixed(1)} g`, zeroLabel: `μ₀ = ${stats.mu0}` },
      { y: 134, title: "2 · restar μ₀ (centrar)", tick: (z) => { const d = z * stats.se; return `${d > 0 ? "+" : ""}${d.toFixed(1)}`; }, valueLabel: `x̄ − μ₀ = ${(stats.xbar - stats.mu0) >= 0 ? "+" : ""}${(stats.xbar - stats.mu0).toFixed(1)} g`, zeroLabel: "0" },
      { y: 214, title: "3 · dividir entre EE (escalar)", tick: (z) => `${z > 0 ? "+" : ""}${z}`, valueLabel: `z = ${stats.z.toFixed(2)}`, zeroLabel: "0" },
    ];

    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(23,60,50,.1)";
    ctx.lineWidth = 1;
    for (let tick = -zSpan; tick <= zSpan; tick += 2) {
      ctx.beginPath();
      ctx.moveTo(ZX(tick), rows[0].y - 14);
      ctx.lineTo(ZX(tick), rows[2].y + 6);
      ctx.stroke();
    }

    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "#bd3a2f";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(ZX(0), rows[0].y - 22);
    ctx.lineTo(ZX(0), rows[2].y + 6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#bd3a2f";
    ctx.font = "800 10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText("la promesa (H₀)", ZX(0), rows[0].y - 28);

    rows.forEach((row) => {
      ctx.strokeStyle = "#173c32";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(left, row.y);
      ctx.lineTo(width - right, row.y);
      ctx.stroke();
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillStyle = "#173c32";
      ctx.textAlign = "center";
      for (let tick = -zSpan; tick <= zSpan; tick += 2) {
        ctx.beginPath();
        ctx.moveTo(ZX(tick), row.y - 4);
        ctx.lineTo(ZX(tick), row.y + 4);
        ctx.stroke();
        ctx.fillText(row.tick(tick), ZX(tick), row.y + 18);
      }
      ctx.textAlign = "left";
      ctx.font = "800 11px ui-sans-serif, system-ui";
      ctx.fillText(row.title, 12, row.y + 4);
    });

    const progress = state.stdAnim ? clamp((performance.now() - state.stdAnim.t0) / STD_DURATION, 0, 1) : null;

    const drawDot = (y, label) => {
      ctx.beginPath();
      ctx.arc(dotX, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#e8a91e";
      ctx.strokeStyle = "#6d3d25";
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      if (label) {
        ctx.fillStyle = "#6d3d25";
        ctx.font = "800 11px ui-monospace, monospace";
        ctx.textAlign = dotX > width - 150 ? "right" : "left";
        ctx.fillText(label, dotX + (dotX > width - 150 ? -11 : 11), y - 10);
        ctx.textAlign = "left";
      }
    };

    const stepLabel = (yFrom, yTo, text) => {
      ctx.strokeStyle = "#6d3d25";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(dotX, yFrom + 8);
      ctx.lineTo(dotX, yTo - 10);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(dotX - 4, yTo - 15);
      ctx.lineTo(dotX, yTo - 9);
      ctx.lineTo(dotX + 4, yTo - 15);
      ctx.stroke();
      ctx.fillStyle = "#6d3d25";
      ctx.font = "italic 700 11px Georgia, serif";
      ctx.textAlign = dotX > width - 170 ? "right" : "left";
      ctx.fillText(text, dotX + (dotX > width - 170 ? -10 : 10), (yFrom + yTo) / 2 + 4);
      ctx.textAlign = "left";
    };

    if (progress === null) {
      drawDot(rows[0].y, rows[0].valueLabel);
      stepLabel(rows[0].y, rows[1].y, `paso 1: restar μ₀ (− ${stats.mu0})`);
      drawDot(rows[1].y, rows[1].valueLabel);
      stepLabel(rows[1].y, rows[2].y, `paso 2: dividir entre EE (÷ ${stats.se.toFixed(2)})`);
      drawDot(rows[2].y, rows[2].valueLabel);
    } else {
      drawDot(rows[0].y, rows[0].valueLabel);
      let y;
      if (progress < 0.42) {
        y = rows[0].y + (rows[1].y - rows[0].y) * easeOut(progress / 0.42);
        stepLabel(rows[0].y, rows[1].y, `paso 1: restar μ₀ (− ${stats.mu0})`);
      } else if (progress < 0.55) {
        y = rows[1].y;
        drawDot(rows[1].y, rows[1].valueLabel);
      } else {
        drawDot(rows[1].y, rows[1].valueLabel);
        y = rows[1].y + (rows[2].y - rows[1].y) * easeOut((progress - 0.55) / 0.45);
        stepLabel(rows[1].y, rows[2].y, `paso 2: dividir entre EE (÷ ${stats.se.toFixed(2)})`);
      }
      if (progress >= 1) drawDot(rows[2].y, rows[2].valueLabel);
      else drawDot(y);
    }
  }

  function standardizeFrame() {
    if (!state.stdAnim) return;
    const elapsed = performance.now() - state.stdAnim.t0;
    drawStandardize();
    if (elapsed >= STD_DURATION) {
      state.stdAnim = null;
      drawStandardize();
      return;
    }
    requestAnimationFrame(standardizeFrame);
  }

  // ---- Muestra observada, intervalo, hipótesis, decisión ----

  function renderSample() {
    const sampleDots = $("#sampleDots");
    sampleDots.replaceChildren();
    const values = state.observed.slice(0, 60);
    values.forEach((value, index) => {
      const dot = document.createElement("span");
      dot.className = `sample-dot${value < 492 ? " low" : value > 508 ? " high" : ""}`;
      dot.style.animationDelay = `${Math.min(index * 18, 600)}ms`;
      dot.textContent = value.toFixed(0);
      dot.setAttribute("aria-label", `${value.toFixed(1)} gramos`);
      sampleDots.append(dot);
    });
  }

  function takeObservedSample({ moveToFirstStep = false } = {}) {
    const n = +controls.n.value;
    state.observed = Array.from({ length: n }, populationObservation);
    state.observedMean = state.observed.reduce((sum, value) => sum + value, 0) / n;
    state.sampleRun += 1;
    $("#sampleRun").textContent = `Muestra #${String(state.sampleRun).padStart(2, "0")}`;
    renderSample();
    if (moveToFirstStep) showStep(1);
    updateAll();
  }

  function updateInterval(stats) {
    const rangeMin = 486;
    const rangeMax = 514;
    const percent = (value) => clamp(((value - rangeMin) / (rangeMax - rangeMin)) * 100, 1, 99);
    const lowPercent = percent(stats.low);
    const highPercent = percent(stats.high);
    const meanPercent = percent(stats.xbar);
    const nullPercent = percent(stats.mu0);
    const intervalLine = $("#intervalLine");
    intervalLine.style.left = `${lowPercent}%`;
    intervalLine.style.width = `${Math.max(1, highPercent - lowPercent)}%`;
    $("#intervalMeanMark").style.left = `${clamp(((meanPercent - lowPercent) / Math.max(highPercent - lowPercent, 1)) * 100, 0, 100)}%`;
    $("#nullMarker").style.left = `${nullPercent}%`;
    $("#ciLow").style.left = `${lowPercent}%`;
    $("#ciMid").style.left = `${meanPercent}%`;
    $("#ciHigh").style.left = `${highPercent}%`;
    $("#ciLow").textContent = stats.low.toFixed(1);
    $("#ciMid").textContent = stats.xbar.toFixed(1);
    $("#ciHigh").textContent = stats.high.toFixed(1);
    $("#ciFormula").textContent = `${stats.xbar.toFixed(1)} ± ${stats.margin.toFixed(2)} g`;
    const contains = stats.low <= stats.mu0 && stats.high >= stats.mu0;
    const interpretation = $("#ciInterpretation");
    interpretation.classList.toggle("excludes", !contains);
    interpretation.innerHTML = contains
      ? "<b>El IC contiene 500 g</b><p>Con este nivel de confianza, la referencia de H₀ sigue siendo compatible con los datos.</p>"
      : "<b>El IC no contiene 500 g</b><p>Para una prueba bilateral con α correspondiente, esto coincide con rechazar H₀.</p>";
    $("#widthBar").style.width = `${clamp((stats.margin / 8) * 100, 8, 100)}%`;
  }

  function updateHypothesisCopy() {
    const alternatives = {
      left: ["H₁: μ < 500 g", "Sólo nos preocupa el subllenado: bolsas con menos café."],
      two: ["H₁: μ ≠ 500 g", "Nos importa cualquier desajuste, por debajo o por encima."],
      right: ["H₁: μ > 500 g", "Sólo nos preocupa el sobrellenado y su costo acumulado."],
    };
    $("#alternativeText").textContent = alternatives[state.direction][0];
    $("#alternativeMeaning").textContent = alternatives[state.direction][1];
    $$(".tail-picker button").forEach((button) => button.classList.toggle("active", button.dataset.direction === state.direction));
    $$(".hyp button").forEach((button) => {
      const legacyDirection = button.dataset.tail === "two" ? "two" : "right";
      button.classList.toggle("active", legacyDirection === state.direction);
    });
  }

  function formatProbability(probability) {
    return probability < 0.0001 ? "< 0.0001" : probability.toFixed(4);
  }

  function updateDecision(stats) {
    const banner = $("#decisionBanner");
    banner.classList.toggle("reject", stats.reject);
    $("#decisionTitle").textContent = stats.reject ? "Rechazar H₀" : "No rechazar H₀";
    $("#decisionReason").textContent = stats.reject
      ? `p = ${formatProbability(stats.p)} < α = ${stats.alpha.toFixed(2)}: la muestra aporta evidencia contra la referencia de 500 g.`
      : `p = ${formatProbability(stats.p)} ≥ α = ${stats.alpha.toFixed(2)}: la evidencia no alcanza el umbral fijado.`;
    const directionPhrase = state.direction === "two" ? "un cambio en la media" : state.direction === "left" ? "subllenado promedio" : "sobrellenado promedio";
    $("#canSay").textContent = stats.reject
      ? `“Con α = ${stats.alpha.toFixed(2)}, encontramos evidencia estadística de ${directionPhrase}.”`
      : `“Con α = ${stats.alpha.toFixed(2)}, no encontramos evidencia estadística suficiente de ${directionPhrase}.”`;
  }

  function updateSidePanel(stats) {
    $("#seValue").textContent = `${stats.se.toFixed(2)} g`;
    $("#ciValue").textContent = `${stats.low.toFixed(1)}—${stats.high.toFixed(1)} g`;
    $("#pValue").textContent = formatProbability(stats.p);
    $("#verdict").textContent = stats.reject ? "Rechazar H₀" : "No rechazar H₀";
    $("#xbarValue").textContent = `${stats.xbar.toFixed(1)} g`;
    $("#alphaValue").textContent = stats.alpha.toFixed(2);
    const sign = state.direction === "two" ? "≠" : state.direction === "left" ? "<" : ">";
    $(".formula").innerHTML = `H₀: μ = 500 g<br>H₁: μ ${sign} 500 g<br>z = (x̄ − μ₀) / (σ / √n) = <b>${stats.z.toFixed(2)}</b>`;
    drawTestChart(stats, miniTestCanvas, miniTestContext, true);
  }

  function updateAll() {
    const mu = +controls.mu.value;
    const sigma = +controls.sigma.value;
    const n = +controls.n.value;
    $("#muOut").textContent = `${mu} g`;
    $("#sigmaOut").textContent = `${sigma} g`;
    $("#nOut").textContent = `${n} bolsas`;
    $("#sampleSizeText").textContent = String(n);
    $("#screenWeight").textContent = state.running ? populationObservation().toFixed(1) : mu.toFixed(1);
    const stats = calculateStatistics();
    $("#observedMean").textContent = `${stats.xbar.toFixed(1)} g`;
    const delta = stats.xbar - stats.mu0;
    $("#observedDelta").textContent = `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} g`;
    $("#sampleSe").textContent = `${stats.se.toFixed(2)} g`;
    $("#detailSe").textContent = stats.se.toFixed(2);
    $("#detailZ").textContent = stats.z.toFixed(2);
    $("#detailP").textContent = formatProbability(stats.p);
    const rarity = stats.p < 0.01 ? "muy poco frecuentes" : stats.p < 0.05 ? "poco frecuentes" : stats.p < 0.2 ? "moderadamente frecuentes" : "muy frecuentes";
    $("#pPlain").textContent = `Si H₀ fuera cierta, resultados al menos tan extremos como éste serían ${rarity} (p = ${formatProbability(stats.p)}).`;
    updateHypothesisCopy();
    updateInterval(stats);
    updateDecision(stats);
    updateSidePanel(stats);
    updateEmpirical();
    drawMainChart();
    drawTestChart(stats);
    drawCiRain();
    drawStandardize();
  }

  function samplingTick() {
    const batch = state.sampleCount < 250 ? 5 : state.sampleCount < 1000 ? 18 : 36;
    const newMeans = Array.from({ length: batch }, sampleMean);
    state.samplingMeans.push(...newMeans);
    if (state.samplingMeans.length > 4000) state.samplingMeans.splice(0, state.samplingMeans.length - 4000);
    state.recentMeans = [...newMeans.slice(-12), ...state.recentMeans].slice(0, 24);
    state.sampleCount += batch;
    $("#count").textContent = state.sampleCount.toLocaleString("es-MX");
    $("#screenWeight").textContent = populationObservation().toFixed(1);
    updateEmpirical();
    drawMainChart();
  }

  function setSampling(shouldRun) {
    state.running = shouldRun;
    const button = $("#startBtn");
    button.setAttribute("aria-pressed", String(shouldRun));
    button.textContent = shouldRun ? "Pausar muestreo automático" : state.sampleCount ? "Continuar muestreo automático" : "Muestreo automático";
    $("#machineStage").classList.toggle("sampling", shouldRun);
    clearInterval(state.timer);
    if (shouldRun) state.timer = window.setInterval(samplingTick, 90);
  }

  function resetSamplingDistribution() {
    state.samplingMeans = [];
    state.recentMeans = [];
    state.sampleCount = 0;
    $("#count").textContent = "0";
    updateEmpirical();
    drawMainChart();
  }

  function showStep(stepNumber) {
    state.currentStep = clamp(stepNumber, 1, 5);
    $$(".step-tab").forEach((button) => {
      const active = +button.dataset.step === state.currentStep;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    $$(".step-panel").forEach((panel) => {
      const active = +panel.dataset.panel === state.currentStep;
      panel.hidden = !active;
      panel.classList.toggle("active", active);
    });
    const nextLabels = [
      "Construir el intervalo \u2192",
      "Plantear la hipótesis \u2192",
      "Medir la evidencia \u2192",
      "Decidir e interpretar \u2192",
      "Volver a extraer una muestra \u21bb",
    ];
    $("#nextStationLabel").textContent = nextLabels[state.currentStep - 1];
    $("#routeCount").textContent = `${String(state.currentStep).padStart(2, "0")} / 05`;
    $("#routeProgress").style.width = `${state.currentStep * 20}%`;
    if (state.currentStep === 2) requestAnimationFrame(drawCiRain);
    if (state.currentStep === 4) requestAnimationFrame(() => { drawTestChart(); drawStandardize(); });
  }

  // ---- Cuestionarios de autoevaluación ----

  $$(".checkpoint").forEach((box) => {
    const feedback = $(".quiz-feedback", box);
    $$(".quiz-options button", box).forEach((button) => button.addEventListener("click", () => {
      const good = button.dataset.good === "1";
      $$(".quiz-options button", box).forEach((other) => other.classList.remove("good", "bad"));
      button.classList.add(good ? "good" : "bad");
      feedback.hidden = false;
      feedback.classList.toggle("ok", good);
      feedback.textContent = good ? box.dataset.yes : box.dataset.no;
    }));
  });

  // ---- Eventos ----

  controls.mu.addEventListener("input", () => {
    resetSamplingDistribution();
    resetCiRain();
    updateAll();
  });
  controls.sigma.addEventListener("input", () => {
    resetSamplingDistribution();
    resetCiRain();
    updateAll();
  });
  controls.n.addEventListener("input", () => {
    resetSamplingDistribution();
    resetCiRain();
    takeObservedSample();
  });
  controls.shape.addEventListener("change", () => {
    state.distribution = controls.shape.value;
    resetSamplingDistribution();
    resetCiRain();
    takeObservedSample();
  });
  controls.confidence.addEventListener("change", () => {
    resetCiRain();
    updateAll();
  });
  controls.alpha.addEventListener("change", updateAll);
  $("#startBtn").addEventListener("click", () => setSampling(!state.running));
  $("#oneSampleBtn").addEventListener("click", startOneSampleAnim);
  $("#burstBtn").addEventListener("click", () => {
    if (state.animSample) return;
    commitMeans(Array.from({ length: 100 }, sampleMean));
  });
  $("#ciRainBtn").addEventListener("click", () => simulateCiBatch(60));
  $("#standardizeBtn").addEventListener("click", () => {
    if (reduceMotion) {
      drawStandardize();
      return;
    }
    state.stdAnim = { t0: performance.now() };
    requestAnimationFrame(standardizeFrame);
  });
  $("#drawSampleBtn").addEventListener("click", () => takeObservedSample());
  $("#newExperimentBtn").addEventListener("click", () => takeObservedSample({ moveToFirstStep: true }));
  $$(".step-tab").forEach((button) => button.addEventListener("click", () => showStep(+button.dataset.step)));
  $("#nextStationBtn").addEventListener("click", () => {
    showStep(state.currentStep === 5 ? 1 : state.currentStep + 1);
    $("#guidedLab").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  });

  $$(".tail-picker button").forEach((button) => button.addEventListener("click", () => {
    state.direction = button.dataset.direction;
    updateAll();
  }));
  $$(".hyp button").forEach((button) => button.addEventListener("click", () => {
    state.direction = button.dataset.tail === "two" ? "two" : "right";
    updateAll();
  }));

  $("#tuneBtn").addEventListener("click", (event) => {
    const isOffset = +controls.mu.value !== 504;
    controls.mu.value = isOffset ? "504" : "500";
    event.currentTarget.textContent = isOffset ? "Recalibrar a 500 g" : "Desajustar +4 g";
    $("#statusText").textContent = isOffset ? "Sesgo real: +4 g" : "Calibración nominal";
    $("#statusDot").style.background = isOffset ? "#bd3a2f" : "#e8a91e";
    $(".machine").classList.add("shake");
    window.setTimeout(() => $(".machine").classList.remove("shake"), 500);
    resetSamplingDistribution();
    resetCiRain();
    takeObservedSample();
  });

  const resizeObserver = new ResizeObserver(() => {
    drawMainChart();
    drawTestChart(calculateStatistics(), miniTestCanvas, miniTestContext, true);
    if (!$("[data-panel='4']").hidden) {
      drawTestChart();
      drawStandardize();
    }
    if (!$("[data-panel='2']").hidden) drawCiRain();
  });
  resizeObserver.observe(chart);
  resizeObserver.observe(testCanvas);
  resizeObserver.observe(miniTestCanvas);
  resizeObserver.observe(ciRainCanvas);
  resizeObserver.observe(standardizeCanvas);

  state.distribution = controls.shape.value;
  takeObservedSample();
  showStep(1);
})();
