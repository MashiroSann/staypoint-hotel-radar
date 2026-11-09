/* 栖点 · STAYPOINT 酒店雷达 —— 前端交互 */
(() => {
  "use strict";

  const FILTER_LEVELS = ["经济型", "舒适型", "高档型", "豪华型", "五星级"];
  const FILTER_TAGS = ["近地铁", "免费停车", "近景点", "家庭房", "会议室", "景观很棒", "浴缸", "接送机"];
  const FILTER_PARAM_KEYS = ["price_min", "price_max", "levels", "min_rating", "min_reviews", "tags", "kw"];

  const els = {};
  const state = {
    query: "",
    radius: 3000,
    onlyBookable: true,
    sort: "distance",
    filters: defaultFilters(),
    hotels: [],
    anchor: null,
    stats: null,
    source: "",
    warning: "",
    disclaimer: "",
    generatedAt: "",
    loading: false,
    reqSeq: 0,
    abort: null,
    selectedUid: null,
    map: null,
    tileLayer: null,
    markersLayer: null,
    markerIndex: new Map(),
    locateMarker: null,
    centerMarker: null,
    circle: null,
    mapKey: "",
    suggestTimer: null,
    suggestItems: [],
    suggestIndex: -1,
    suggestSeq: 0,
    drawerUid: null,
    drawerReturnFocus: null,
    drawerCloseTimer: null,
    detailGallery: [],
    lightboxIndex: 0,
    lightboxReturnFocus: null,
    aboutReturnFocus: null,
  };

  const SVG = {
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-5.4 7-11A7 7 0 0 0 5 10c0 5.6 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h3l1.5 4L9 9.5a13 13 0 0 0 5.5 5.5l1.5-2.5 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 5 6a2 2 0 0 1 2-2Z"/></svg>',
    map: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2Z"/><path d="M9 4v14M15 6v14"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2"/></svg>',
    empty: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16 16 4.5 4.5M8 11h6"/></svg>',
    warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19Z"/><path d="M12 9v5M12 17v.2"/></svg>',
  };

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
  const fmtNum = (n) => Number(n).toLocaleString("zh-CN");
  const proxyImg = (url) => "/api/image?u=" + encodeURIComponent(url);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* ---------------- filter state ---------------- */
  function defaultFilters() {
    return {
      price_min: 0,
      price_max: 0,
      levels: [],
      min_rating: 0,
      min_reviews: 0,
      tags: [],
      kw: "",
    };
  }

  function splitList(value) {
    if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
    return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  }

  function filterNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeClientFilters(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    let priceMin = Math.max(0, Math.round(filterNumber(source.price_min, 0)));
    let priceMax = Math.max(0, Math.round(filterNumber(source.price_max, 0)));
    if (priceMin && priceMax && priceMin > priceMax) {
      [priceMin, priceMax] = [priceMax, priceMin];
    }
    return {
      price_min: priceMin,
      price_max: priceMax,
      levels: [...new Set(splitList(source.levels).filter((item) => FILTER_LEVELS.includes(item)))],
      min_rating: Math.max(0, Math.min(5, Math.round(filterNumber(source.min_rating, 0) * 10) / 10)),
      min_reviews: Math.max(0, Math.round(filterNumber(source.min_reviews, 0))),
      tags: [...new Set(splitList(source.tags).filter((item) => FILTER_TAGS.includes(item)))].slice(0, 12),
      kw: String(source.kw || "").trim().slice(0, 40),
    };
  }

  function filterActiveCount() {
    const f = state.filters || defaultFilters();
    return [
      !!(f.price_min || f.price_max),
      !!(f.levels && f.levels.length),
      !!f.min_rating,
      !!f.min_reviews,
      !!(f.tags && f.tags.length),
      !!f.kw,
    ].filter(Boolean).length;
  }

  function appendFilterParams(params) {
    const f = state.filters || defaultFilters();
    if (f.price_min) params.set("price_min", String(f.price_min));
    if (f.price_max) params.set("price_max", String(f.price_max));
    if (f.levels.length) params.set("levels", f.levels.join(","));
    if (f.min_rating) params.set("min_rating", String(f.min_rating));
    if (f.min_reviews) params.set("min_reviews", String(f.min_reviews));
    if (f.tags.length) params.set("tags", f.tags.join(","));
    if (f.kw) params.set("kw", f.kw);
  }

  function readFiltersFromParams(params) {
    return normalizeClientFilters({
      price_min: params.get("price_min"),
      price_max: params.get("price_max"),
      levels: params.get("levels"),
      min_rating: params.get("min_rating"),
      min_reviews: params.get("min_reviews"),
      tags: params.get("tags"),
      kw: params.get("kw"),
    });
  }

  function readSavedFilters() {
    try {
      const raw = readPref("sp_filters");
      return raw ? normalizeClientFilters(JSON.parse(raw)) : defaultFilters();
    } catch (_) {
      return defaultFilters();
    }
  }

  function saveFilters() {
    savePref("sp_filters", JSON.stringify(state.filters || defaultFilters()));
  }

  function imgTag(url, alt, eager = false) {
    if (!url) return "";
    return `<img src="${proxyImg(url)}" alt="${esc(alt)}" loading="${eager ? "eager" : "lazy"}" decoding="async" onerror="this.onerror=null;this.style.display='none';this.parentElement.classList.add('img-fallback')">`;
  }

  function fmtDist(m) {
    const n = Math.max(0, Number(m) || 0);
    if (n < 1000) return `${Math.round(n)} 米`;
    const km = n / 1000;
    return `${km >= 10 ? Math.round(km) : Number(km.toFixed(1))} 公里`;
  }

  function zoomForRadius(radius) {
    const r = Number(radius) || 3000;
    if (r <= 1000) return 15;
    if (r <= 2000) return 14;
    if (r <= 4000) return 13.5;
    if (r <= 8000) return 12.5;
    if (r <= 15000) return 11.5;
    return 10.5;
  }

  function starText(level) {
    const map = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5 };
    const match = String(level || "").match(/([一二三四五])星/);
    return match ? "★".repeat(map[match[1]]) : "";
  }

  function sourceShort(src) {
    const text = String(src || "").trim();
    if (!text) return "";
    const key = text.toLowerCase().replace(/^来自/, "").trim();
    const known = {
      xiecheng: "携程",
      ctrip: "携程",
      meituan: "美团",
      qunar: "去哪儿",
      dianping: "大众点评",
      baidu: "百度地图",
    };
    return known[key] || text.replace(/^来自/, "").slice(0, 10);
  }

  function syncBodyLock() {
    const locked = els.drawer.classList.contains("open") || !els.lightbox.hidden || !els.aboutModal.hidden;
    document.body.style.overflow = locked ? "hidden" : "";
  }

  function toast(message, duration = 2600) {
    clearTimeout(toast._timer);
    els.toast.textContent = message;
    els.toast.hidden = false;
    toast._timer = setTimeout(() => { els.toast.hidden = true; }, duration);
  }

  function savePref(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (_) { /* ignore */ }
  }

  function readPref(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function syncUrl() {
    try {
      const params = new URLSearchParams();
      params.set("q", state.query);
      params.set("radius", String(state.radius));
      if (!state.onlyBookable) params.set("bookable", "0");
      appendFilterParams(params);
      history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
    } catch (_) { /* ignore */ }
  }

  /* ---------------- boot ---------------- */
  function cacheEls() {
    [
      "query", "clearBtn", "suggestBox", "searchBtn", "radius", "onlyBookable",
      "sortTabs", "filterBtn", "filterBadge", "filterPanel", "activeFilters",
      "filterPriceMin", "filterPriceMax", "filterRating", "filterReviews", "filterKw",
      "pricePresets", "levelChecks", "tagChecks", "filterApply", "filterReset",
      "statBar", "warningBar", "resultsList", "resultsFooter",
      "footerCount", "resultEyebrow", "resultTitle", "resultSub", "sourceBadge",
      "mapPanel", "mapChip", "tileFallback", "mapLegend", "centerBtn",
      "drawer", "drawerScrim", "drawerInner", "lightbox", "lightboxImg",
      "lightboxCaption", "lightboxClose", "lightboxPrev", "lightboxNext",
      "aboutModal", "aboutBtn", "aboutClose", "toast", "livePill", "quickRow",
    ].forEach((id) => { els[id] = $(id); });
  }

  function boot() {
    cacheEls();
    bindEvents();
    initMap();
    restorePrefs();
    const initial = state.query || "上海外滩";
    els.query.value = initial;
    updateClearBtn();
    setTimeout(() => runSearch(), 380);
  }

  function restorePrefs() {
    let params;
    try { params = new URLSearchParams(location.search); } catch (_) { params = new URLSearchParams(); }
    const savedRadius = Number(readPref("sp_radius"));
    const urlRadius = Number(params.get("radius"));
    const radius = [500, 1000, 2000, 3000, 5000, 10000].includes(urlRadius)
      ? urlRadius
      : ([500, 1000, 2000, 3000, 5000, 10000].includes(savedRadius) ? savedRadius : 3000);
    state.radius = radius;
    els.radius.value = String(radius);

    const urlBookable = params.get("bookable");
    const savedBookable = readPref("sp_bookable");
    state.onlyBookable = urlBookable === "0" ? false : (urlBookable === "1" ? true : savedBookable !== "0");
    els.onlyBookable.checked = state.onlyBookable;

    state.query = (params.get("q") || readPref("sp_last_query") || "").trim();

    const hasUrlFilters = FILTER_PARAM_KEYS.some((key) => params.has(key));
    state.filters = hasUrlFilters ? readFiltersFromParams(params) : readSavedFilters();
    fillFilterControls();
    updateFilterButton();
    renderActiveFilters();
  }

  /* ---------------- events ---------------- */
  function bindEvents() {
    els.searchBtn.addEventListener("click", () => runSearch());
    els.query.addEventListener("input", onQueryInput);
    els.query.addEventListener("keydown", onQueryKeydown);
    els.query.addEventListener("focus", () => {
      if (els.query.value.trim().length >= 1 && state.suggestItems.length) showSuggest();
    });
    els.clearBtn.addEventListener("click", () => {
      els.query.value = "";
      updateClearBtn();
      hideSuggest();
      els.query.focus();
    });

    els.radius.addEventListener("change", () => {
      state.radius = Number(els.radius.value) || 3000;
      savePref("sp_radius", state.radius);
      if (state.anchor) runSearch();
    });

    els.onlyBookable.addEventListener("change", () => {
      state.onlyBookable = els.onlyBookable.checked;
      savePref("sp_bookable", state.onlyBookable ? "1" : "0");
      if (state.anchor) runSearch();
    });

    els.sortTabs.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-sort]");
      if (!btn || btn.classList.contains("active")) return;
      state.sort = btn.dataset.sort || "distance";
      [...els.sortTabs.querySelectorAll("[data-sort]")].forEach((item) => {
        const active = item === btn;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
      });
      if (state.anchor) runSearch();
    });

    els.filterBtn.addEventListener("click", () => setFilterPanel(els.filterPanel.hidden));
    els.pricePresets.addEventListener("click", (event) => {
      const button = event.target.closest("[data-price-min]");
      if (!button) return;
      els.filterPriceMin.value = Number(button.dataset.priceMin) ? String(button.dataset.priceMin) : "";
      els.filterPriceMax.value = Number(button.dataset.priceMax) ? String(button.dataset.priceMax) : "";
      syncPricePresetState();
    });
    [els.filterPriceMin, els.filterPriceMax].forEach((input) => {
      input.addEventListener("input", syncPricePresetState);
    });
    els.filterApply.addEventListener("click", applyFilterPanel);
    els.filterReset.addEventListener("click", () => {
      resetFilterState(false);
      setFilterPanel(false);
      if (state.anchor) runSearch();
    });
    els.filterKw.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      applyFilterPanel();
    });
    els.activeFilters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove]");
      if (!button) return;
      if (button.dataset.remove === "all") {
        resetFilterState(true);
        return;
      }
      removeFilter(button.dataset.remove, button.dataset.value || "");
      if (state.anchor) runSearch();
    });

    els.quickRow.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-query]");
      if (!chip) return;
      els.query.value = chip.dataset.query || "";
      updateClearBtn();
      runSearch();
    });

    els.resultsList.addEventListener("click", onResultsClick);
    els.resultsList.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.target.closest("button, a, input, select, textarea")) return;
      const card = event.target.closest(".hotel-card");
      if (!card) return;
      event.preventDefault();
      openDetail(card.dataset.uid);
    });

    els.suggestBox.addEventListener("click", (event) => {
      const item = event.target.closest(".suggest-item");
      if (!item) return;
      chooseSuggest(Number(item.dataset.index));
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".search-field")) hideSuggest();
      if (!els.filterPanel.hidden
        && !event.target.closest(".filter-panel")
        && !event.target.closest("#filterBtn")) {
        setFilterPanel(false);
      }
    });

    els.centerBtn.addEventListener("click", () => {
      if (!state.map || !state.anchor) return;
      state.map.flyTo([state.anchor.lat, state.anchor.lng], 15, { duration: 0.7 });
    });

    els.drawerScrim.addEventListener("click", () => closeDetail());
    els.drawerInner.addEventListener("click", onDrawerClick);

    els.aboutBtn.addEventListener("click", openAbout);
    els.aboutClose.addEventListener("click", closeAbout);
    els.aboutModal.addEventListener("click", (event) => {
      if (event.target === els.aboutModal) closeAbout();
    });

    els.lightboxClose.addEventListener("click", closeLightbox);
    els.lightboxPrev.addEventListener("click", () => navLightbox(-1));
    els.lightboxNext.addEventListener("click", () => navLightbox(1));
    els.lightbox.addEventListener("click", (event) => {
      if (event.target === els.lightbox) closeLightbox();
    });
    els.lightboxImg.addEventListener("error", () => {
      els.lightboxCaption.textContent = "图片加载失败，请稍后再试";
    });

    document.addEventListener("keydown", onGlobalKeydown);
    window.addEventListener("resize", onResize);
  }

  /* ---------------- detailed filters ---------------- */
  function setFilterPanel(open) {
    const show = Boolean(open);
    els.filterPanel.hidden = !show;
    els.filterBtn.classList.toggle("open", show);
    els.filterBtn.setAttribute("aria-expanded", show ? "true" : "false");
    if (show) fillFilterControls();
  }

  function fillFilterControls() {
    const f = state.filters || defaultFilters();
    els.filterPriceMin.value = f.price_min > 0 ? String(f.price_min) : "";
    els.filterPriceMax.value = f.price_max > 0 ? String(f.price_max) : "";
    [...els.levelChecks.querySelectorAll('input[type="checkbox"]')].forEach((input) => {
      input.checked = f.levels.includes(input.value);
    });
    [...els.tagChecks.querySelectorAll('input[type="checkbox"]')].forEach((input) => {
      input.checked = f.tags.includes(input.value);
    });
    els.filterRating.value = f.min_rating ? Number(f.min_rating).toFixed(1) : "0";
    els.filterReviews.value = f.min_reviews ? String(f.min_reviews) : "0";
    els.filterKw.value = f.kw || "";
    syncPricePresetState();
  }

  function syncPricePresetState() {
    const min = Math.max(0, Number(els.filterPriceMin.value) || 0);
    const max = Math.max(0, Number(els.filterPriceMax.value) || 0);
    [...els.pricePresets.querySelectorAll("button")].forEach((button) => {
      const presetMin = Number(button.dataset.priceMin) || 0;
      const presetMax = Number(button.dataset.priceMax) || 0;
      button.classList.toggle("active", (min || max) && min === presetMin && max === presetMax);
    });
  }

  function updateFilterButton() {
    const count = filterActiveCount();
    els.filterBadge.hidden = count === 0;
    els.filterBadge.textContent = String(count);
    els.filterBtn.classList.toggle("has-filters", count > 0);
    els.filterBtn.setAttribute("aria-expanded", els.filterPanel.hidden ? "false" : "true");
  }

  function readFilterPanel() {
    return normalizeClientFilters({
      price_min: els.filterPriceMin.value,
      price_max: els.filterPriceMax.value,
      levels: [...els.levelChecks.querySelectorAll('input:checked')].map((input) => input.value),
      min_rating: els.filterRating.value,
      min_reviews: els.filterReviews.value,
      tags: [...els.tagChecks.querySelectorAll('input:checked')].map((input) => input.value),
      kw: els.filterKw.value,
    });
  }

  function applyFilterPanel() {
    state.filters = readFilterPanel();
    saveFilters();
    fillFilterControls();
    updateFilterButton();
    renderActiveFilters();
    setFilterPanel(false);
    if (state.anchor) runSearch();
    else toast("筛选条件已记录，点击「搜索酒店」后生效");
  }

  function resetFilterState(search) {
    state.filters = defaultFilters();
    saveFilters();
    fillFilterControls();
    updateFilterButton();
    renderActiveFilters();
    if (search && state.anchor) runSearch();
  }

  function removeFilter(type, value) {
    const f = normalizeClientFilters(state.filters || defaultFilters());
    if (type === "price") {
      f.price_min = 0;
      f.price_max = 0;
    } else if (type === "level") {
      f.levels = f.levels.filter((item) => item !== value);
    } else if (type === "tag") {
      f.tags = f.tags.filter((item) => item !== value);
    } else if (type === "rating") {
      f.min_rating = 0;
    } else if (type === "reviews") {
      f.min_reviews = 0;
    } else if (type === "kw") {
      f.kw = "";
    }
    state.filters = normalizeClientFilters(f);
    saveFilters();
    fillFilterControls();
    updateFilterButton();
    renderActiveFilters();
  }

  function priceFilterLabel(f) {
    if (f.price_min && f.price_max) return `¥${fmtNum(f.price_min)}–¥${fmtNum(f.price_max)}`;
    if (f.price_min) return `¥${fmtNum(f.price_min)} 起`;
    if (f.price_max) return `¥${fmtNum(f.price_max)} 以下`;
    return "";
  }

  function renderActiveFilters() {
    const f = state.filters || defaultFilters();
    const chips = [];
    if (f.price_min || f.price_max) chips.push({ type: "price", value: "", label: priceFilterLabel(f) });
    f.levels.forEach((level) => chips.push({ type: "level", value: level, label: level }));
    if (f.min_rating) chips.push({ type: "rating", value: "", label: `评分 ≥ ${Number(f.min_rating).toFixed(1)}` });
    if (f.min_reviews) chips.push({ type: "reviews", value: "", label: `评价 ≥ ${fmtNum(f.min_reviews)} 条` });
    f.tags.forEach((tag) => chips.push({ type: "tag", value: tag, label: tag }));
    if (f.kw) chips.push({ type: "kw", value: "", label: `名称：${f.kw}` });
    els.activeFilters.hidden = chips.length === 0;
    if (!chips.length) {
      els.activeFilters.innerHTML = "";
      return;
    }
    els.activeFilters.innerHTML = `<span class="af-label">已筛选</span>${chips.map((chip) => `
      <button type="button" class="af-chip" data-remove="${chip.type}" data-value="${esc(chip.value)}" title="移除这个条件">
        ${esc(chip.label)}<span class="af-x">×</span>
      </button>`).join("")}<button type="button" class="af-clear" data-remove="all">清除全部</button>`;
  }

  function onQueryInput() {
    updateClearBtn();
    clearTimeout(state.suggestTimer);
    const q = els.query.value.trim();
    if (!q) {
      hideSuggest();
      return;
    }
    state.suggestTimer = setTimeout(() => loadSuggest(q), 220);
  }

  function onQueryKeydown(event) {
    if (event.key === "Escape") {
      hideSuggest();
      event.stopPropagation();
      return;
    }
    if (!state.suggestItems.length || els.suggestBox.hidden) {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSuggestActive(state.suggestIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSuggestActive(state.suggestIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (state.suggestIndex >= 0) chooseSuggest(state.suggestIndex);
      else runSearch();
    }
  }

  function onGlobalKeydown(event) {
    if (event.key === "Escape") {
      if (!els.lightbox.hidden) { closeLightbox(); return; }
      if (!els.aboutModal.hidden) { closeAbout(); return; }
      if (els.drawer.classList.contains("open")) { closeDetail(); return; }
      if (!els.filterPanel.hidden) { setFilterPanel(false); return; }
    }
    if (!els.lightbox.hidden) {
      if (event.key === "ArrowLeft") navLightbox(-1);
      if (event.key === "ArrowRight") navLightbox(1);
    }
  }

  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.map) state.map.invalidateSize(); }, 160);
  }

  /* ---------------- suggestions ---------------- */
  async function loadSuggest(q) {
    const seq = ++state.suggestSeq;
    try {
      const res = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`, { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = await res.json();
      if (seq !== state.suggestSeq || !data || !data.ok) return;
      state.suggestItems = (data.items || []).slice(0, 8);
      state.suggestIndex = state.suggestItems.length ? 0 : -1;
      renderSuggest();
    } catch (_) {
      if (seq === state.suggestSeq) hideSuggest();
    }
  }

  function renderSuggest() {
    if (!state.suggestItems.length) { hideSuggest(); return; }
    els.suggestBox.innerHTML = state.suggestItems.map((item, index) => {
      const city = String(item.city || "").trim();
      const district = String(item.district || "").trim();
      const meta = [district, city].filter(Boolean).join(" · ");
      return `<button type="button" class="suggest-item${index === state.suggestIndex ? " active" : ""}" data-index="${index}" role="option" aria-selected="${index === state.suggestIndex}">
        <span class="s-pin">${SVG.pin}</span>
        <span class="s-main"><span class="s-name">${esc(item.name)}</span><span class="s-meta">${esc(meta)}</span></span>
      </button>`;
    }).join("");
    els.suggestBox.hidden = false;
  }

  function showSuggest() {
    if (state.suggestItems.length) els.suggestBox.hidden = false;
  }

  function hideSuggest() {
    state.suggestSeq += 1;
    els.suggestBox.hidden = true;
    els.suggestBox.innerHTML = "";
    state.suggestItems = [];
    state.suggestIndex = -1;
  }

  function setSuggestActive(index) {
    if (!state.suggestItems.length) return;
    state.suggestIndex = (index + state.suggestItems.length) % state.suggestItems.length;
    [...els.suggestBox.querySelectorAll(".suggest-item")].forEach((item, i) => {
      item.classList.toggle("active", i === state.suggestIndex);
      item.setAttribute("aria-selected", i === state.suggestIndex ? "true" : "false");
      if (i === state.suggestIndex) item.scrollIntoView({ block: "nearest" });
    });
  }

  function chooseSuggest(index) {
    const row = state.suggestItems[index];
    if (!row) return;
    const city = String(row.city || "").replace(/市$/, "");
    let query = String(row.name || "").trim();
    if (city && query && !query.includes(city)) query = city + query;
    if (!query) return;
    els.query.value = query;
    updateClearBtn();
    hideSuggest();
    runSearch();
  }

  function updateClearBtn() {
    els.clearBtn.hidden = !els.query.value;
  }

  /* ---------------- search ---------------- */
  async function runSearch() {
    const query = els.query.value.trim();
    if (!query) {
      toast("请输入地区或地标，例如「上海外滩」");
      els.query.focus();
      return;
    }
    if (query.length > 60) {
      toast("搜索词太长，请精简后重试");
      return;
    }

    clearTimeout(state.suggestTimer);
    hideSuggest();
    if (els.drawer.classList.contains("open")) closeDetail(true);
    if (!els.lightbox.hidden) closeLightbox(true);

    state.query = query;
    state.loading = true;
    const seq = ++state.reqSeq;
    if (state.abort) state.abort.abort();
    const controller = new AbortController();
    state.abort = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);

    setLoadingUI(true);
    showSkeleton();

    const params = new URLSearchParams({
      q: query,
      radius: String(state.radius),
      bookable: state.onlyBookable ? "1" : "0",
      sort: state.sort,
    });
    appendFilterParams(params);

    try {
      const res = await fetch(`/api/search?${params.toString()}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (seq !== state.reqSeq) return;
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || `查询失败（HTTP ${res.status}）`);
      }
      applyResult(data);
      savePref("sp_last_query", query);
      savePref("sp_radius", state.radius);
      syncUrl();
    } catch (err) {
      if (seq !== state.reqSeq) return;
      if (err && err.name === "AbortError" && !timedOut) return;
      let message = err && err.message ? err.message : "查询失败，请检查网络后重试。";
      if (err instanceof TypeError) message = "无法连接本地服务，请确认「启动.bat」窗口仍在运行。";
      showErrorState(timedOut ? "请求超时，百度地图响应较慢，请稍后重试。" : message);
    } finally {
      clearTimeout(timeout);
      if (seq === state.reqSeq) {
        state.loading = false;
        state.abort = null;
        setLoadingUI(false);
      }
    }
  }

  function setLoadingUI(loading) {
    els.searchBtn.classList.toggle("loading", loading);
    const label = els.searchBtn.querySelector("span");
    if (label) label.textContent = loading ? "搜索中…" : "搜索酒店";
    els.query.disabled = loading;
  }

  function showSkeleton() {
    els.resultEyebrow.textContent = "RADAR / SCANNING";
    els.resultTitle.textContent = "正在扫描周边酒店…";
    els.resultSub.textContent = "正在从百度地图公开页面抓取酒店，并按半径计算距离";
    els.sourceBadge.hidden = true;
    els.statBar.hidden = true;
    els.warningBar.hidden = true;
    els.resultsFooter.hidden = true;
    els.resultsList.innerHTML = Array.from({ length: 4 }, () => `
      <div class="skeleton-card" aria-hidden="true">
        <div class="sk sk-thumb"></div>
        <div class="sk-lines">
          <div class="sk sk-line w80"></div>
          <div class="sk sk-line w40"></div>
          <div class="sk sk-line w60"></div>
          <div class="sk sk-line w80" style="margin-top:auto"></div>
        </div>
      </div>`).join("");
  }

  function applyResult(data) {
    state.hotels = Array.isArray(data.hotels) ? data.hotels : [];
    state.anchor = data.anchor || null;
    state.stats = data.stats || { count: 0, available: 0 };
    state.radius = Number(data.radius_m) || state.radius;
    state.source = String(data.source || "live");
    state.warning = String(data.warning || "");
    state.disclaimer = String(data.disclaimer || "");
    state.generatedAt = String(data.generated_at || "");
    state.selectedUid = null;
    if (data.filters && typeof data.filters === "object") {
      state.filters = normalizeClientFilters(data.filters);
      saveFilters();
    }

    if (els.radius.value !== String(state.radius)) els.radius.value = String(state.radius);
    fillFilterControls();
    updateFilterButton();
    renderActiveFilters();
    setLivePill(state.source);
    renderHeader();
    renderStats();
    renderResults();
    renderFooter();
    drawMap();
    els.resultsList.scrollTop = 0;
    if (state.map) setTimeout(() => state.map.invalidateSize(), 80);
  }

  function setLivePill(source) {
    const label = els.livePill.querySelector("span");
    els.livePill.classList.toggle("offline", source !== "live");
    if (source === "live") {
      if (label) label.textContent = "百度地图实时数据";
      els.livePill.title = "数据来自百度地图公开页面";
    } else if (source === "offline") {
      if (label) label.textContent = "离线样本数据";
      els.livePill.title = "实时数据暂不可用，当前展示内置离线样本";
    } else {
      if (label) label.textContent = "数据暂不可用";
    }
  }

  function renderHeader() {
    const anchor = state.anchor || {};
    const name = String(anchor.name || state.query || "地标");
    const city = String(anchor.city || "");
    els.resultEyebrow.textContent = `RADAR / ${city || "CITY"}`;
    els.resultTitle.textContent = `${name} · 周边酒店`;
    const sortLabel = { distance: "由近到远", price: "价格优先", rating: "评分优先" }[state.sort] || "由近到远";
    const stats = state.stats || {};
    const shown = state.hotels.length;
    const total = stats.count != null ? Number(stats.count) : Number(stats.total_found || shown);
    const truncated = total > shown ? ` · 展示前 ${shown} 家` : "";
    const activeFilters = filterActiveCount();
    const filterNote = activeFilters ? ` · 筛选 ${activeFilters} 项` : "";
    els.resultSub.textContent = `半径 ${fmtDist(state.radius)} 内 ${total} 家${state.onlyBookable ? "可订" : ""}酒店 · ${sortLabel}${filterNote}${truncated}`;
    if (city) document.title = `${name}周边酒店 · 栖点 STAYPOINT`;

    const badge = els.sourceBadge;
    badge.hidden = false;
    badge.textContent = state.source === "offline" ? "内置离线样本" : "百度地图实时数据";
    badge.classList.toggle("offline", state.source === "offline");
  }

  function renderStats() {
    const stats = state.stats || {};
    const anchor = state.anchor || {};
    const total = Number(stats.total_found || stats.count || 0);
    const bits = [];
    if (anchor.name) bits.push(`中心 <b>${esc(anchor.name)}</b>`);
    bits.push(`半径 <b>${fmtDist(state.radius)}</b>`);
    bits.push(`共 <b>${total}</b> 家`);
    if (stats.available) bits.push(`今晚可订 <b>${stats.available}</b> 家`);
    if (stats.min_price > 0) bits.push(`起价 <b>¥${fmtNum(stats.min_price)}–¥${fmtNum(stats.max_price)}</b>`);
    if (stats.avg_rating > 0) bits.push(`平均评分 <b>${stats.avg_rating}</b>`);
    els.statBar.innerHTML = bits.join('<span class="sep">·</span>');
    els.statBar.hidden = false;

    if (state.warning) {
      els.warningBar.textContent = state.warning;
      els.warningBar.hidden = false;
    } else {
      els.warningBar.hidden = true;
    }
  }

  function renderResults() {
    if (!state.hotels.length) {
      renderEmpty();
      return;
    }
    els.resultsList.innerHTML = state.hotels.map(renderCard).join("");
  }

  function renderCard(hotel) {
    const level = String(hotel.level || "");
    const status = hotel.available
      ? { text: "今晚可订", cls: "" }
      : (hotel.fullroom ? { text: "今晚满房", cls: " off" } : { text: "暂不可订", cls: " off" });
    const tags = (hotel.tags || []).slice(0, 3);
    const stars = starText(level);
    const src = sourceShort(hotel.rating_src);
    const rating = Number(hotel.rating) > 0
      ? `<span class="rating-score${hotel.rating >= 4.7 ? " high" : ""}">${Number(hotel.rating).toFixed(1)}</span>
         ${stars ? `<span class="rating-stars">${stars}</span>` : ""}
         <span>${fmtNum(hotel.review_total || hotel.review_count || 0)} 条评价</span>
         ${src ? `<span class="rating-src">· ${esc(src)}</span>` : ""}`
      : `<span class="rating-src">暂无公开评分</span>`;
    const price = Number(hotel.price) > 0
      ? `<div class="price-main"><span class="yen">¥</span>${fmtNum(hotel.price)}<small>起</small></div>
         <div class="price-note">公开实时起价</div>`
      : `<div class="price-main"><span class="ask">询价</span></div>
         <div class="price-note">暂无公开起价</div>`;
    const thumbClass = hotel.cover ? "card-thumb" : "card-thumb img-fallback";
    return `<article class="hotel-card" data-uid="${esc(hotel.uid)}" tabindex="0" role="button" aria-label="查看 ${esc(hotel.name)} 的详情">
      <div class="${thumbClass}">
        ${imgTag(hotel.cover, hotel.name)}
        ${level ? `<span class="chip-level">${esc(level)}</span>` : ""}
        <span class="chip-dist">${fmtDist(hotel.distance_m)}</span>
        <span class="chip-status${status.cls}">${status.text}</span>
      </div>
      <div class="card-body">
        <h3 class="card-name">${esc(hotel.name)}</h3>
        <div class="card-rating">${rating}</div>
        <div class="card-addr" title="${esc(hotel.address || "")}">${esc(hotel.address || "地址未公开")}</div>
        <div class="card-tags">${tags.map((tag) => `<span>${esc(tag)}</span>`).join("")}</div>
        <div class="card-bottom">
          <div class="price-block">${price}</div>
          <div class="card-actions">
            <button type="button" class="card-locate" data-act="locate" title="在地图上定位这家酒店" aria-label="在地图上定位 ${esc(hotel.name)}">${SVG.pin}<span>定位</span></button>
            <span class="card-cta">房型 / 评论 ${SVG.arrow}</span>
          </div>
        </div>
      </div>
    </article>`;
  }

  function nextRadius() {
    const values = [...els.radius.options].map((opt) => Number(opt.value));
    const pos = values.indexOf(state.radius);
    return pos >= 0 && pos < values.length - 1 ? values[pos + 1] : null;
  }

  function renderEmpty() {
    const next = nextRadius();
    const filtered = filterActiveCount() > 0;
    const clearFilterBtn = filtered
      ? `<button type="button" class="state-btn primary" data-act="clear-filters">清除筛选条件</button>`
      : "";
    const showAllBtn = !filtered && state.onlyBookable
      ? `<button type="button" class="state-btn primary" data-act="show-all">查看全部酒店</button>`
      : "";
    const expandBtn = next
      ? `<button type="button" class="state-btn" data-act="expand-radius">半径扩大到 ${fmtDist(next)}</button>`
      : "";
    const title = filtered
      ? "没有符合筛选条件的酒店"
      : (state.onlyBookable ? "这个范围里暂时没有可订酒店" : "这个范围里没有找到酒店");
    const desc = filtered
      ? "可以放宽价格、酒店档次、评分或设施条件；也可以清除筛选，查看半径内的全部酒店。"
      : "可以关闭「仅看今晚可订」查看全部酒店，或扩大查询半径；也可以换一个更具体的地标再试。";
    els.resultsList.innerHTML = `<div class="state-card">
      <div class="state-icon">${SVG.empty}</div>
      <h3>${title}</h3>
      <p>${desc}</p>
      <div class="state-actions">${clearFilterBtn}${showAllBtn}${expandBtn}<button type="button" class="state-btn" data-act="retry">重新搜索</button></div>
    </div>`;
  }

  function renderFooter() {
    els.resultsFooter.hidden = false;
    const count = state.hotels.length;
    const total = Number((state.stats && state.stats.total_found) || count);
    els.footerCount.textContent = `显示 ${count} 家${total > count ? ` / 共 ${total} 家` : ""}${state.generatedAt ? " · " + state.generatedAt : ""}`;
  }

  function onResultsClick(event) {
    const action = event.target.closest("[data-act]");
    if (action) {
      const act = action.dataset.act;
      if (act === "locate") {
        const card = action.closest(".hotel-card");
        if (card) locateHotel(card.dataset.uid);
        return;
      }
      if (act === "retry") runSearch();
      else if (act === "clear-filters") {
        resetFilterState(false);
        runSearch();
      } else if (act === "show-all") {
        state.onlyBookable = false;
        els.onlyBookable.checked = false;
        savePref("sp_bookable", "0");
        runSearch();
      } else if (act === "expand-radius") {
        const next = nextRadius();
        if (!next) { toast("已经是最大查询半径"); return; }
        state.radius = next;
        els.radius.value = String(next);
        savePref("sp_radius", next);
        runSearch();
      }
      return;
    }
    const card = event.target.closest(".hotel-card");
    if (!card) return;
    selectHotel(card.dataset.uid);
    openDetail(card.dataset.uid);
  }

  function showErrorState(message) {
    els.resultEyebrow.textContent = "RADAR / OFFLINE";
    els.resultTitle.textContent = "查询没有完成";
    els.resultSub.textContent = "请检查网络，或确认本地服务仍在运行";
    els.sourceBadge.hidden = true;
    els.statBar.hidden = true;
    els.warningBar.hidden = true;
    els.resultsFooter.hidden = true;
    els.resultsList.innerHTML = `<div class="state-card">
      <div class="state-icon">${SVG.warn}</div>
      <h3>这次没有连上数据源</h3>
      <p>${esc(message)}</p>
      <div class="state-actions"><button type="button" class="state-btn primary" data-act="retry">重新搜索</button></div>
    </div>`;
    setLivePill("error");
  }

  /* ---------------- map ---------------- */
  function initMap() {
    if (!window.L) {
      markTilesFailed("地图组件未能加载，酒店列表仍可正常使用。");
      return;
    }
    try {
      const map = L.map("map", {
        zoomControl: false,
        attributionControl: true,
        minZoom: 3,
        maxZoom: 18,
        zoomSnap: 0.5,
        zoomDelta: 0.5,
      }).setView([31.2329, 121.4927], 13);
      L.control.zoom({ position: "topright" }).addTo(map);
      state.map = map;
      if (L.markerClusterGroup) {
        state.markersLayer = L.markerClusterGroup({
          showCoverageOnHover: false,
          spiderfyOnMaxZoom: true,
          maxClusterRadius: 42,
          disableClusteringAtZoom: 17,
          iconCreateFunction(cluster) {
            const children = cluster.getAllChildMarkers();
            const prices = children
              .map((child) => Number(child.options.priceValue) || 0)
              .filter((value) => value > 0);
            const min = prices.length ? Math.min(...prices) : 0;
            return L.divIcon({
              className: "price-cluster-wrap",
              html: `<div class="price-cluster"><b>${children.length}</b><span>家</span>${min ? `<small>¥${fmtNum(min)}起</small>` : ""}</div>`,
              iconSize: [1, 1],
              iconAnchor: [0, 0],
            });
          },
        }).addTo(map);
      } else {
        state.markersLayer = L.layerGroup().addTo(map);
      }

      let anyTileLoaded = false;
      const tileLayer = L.tileLayer(
        "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
        { subdomains: "1234", maxZoom: 18, attribution: "© 高德地图" },
      );
      state.tileLayer = tileLayer;
      tileLayer.on("tileload", () => {
        anyTileLoaded = true;
        if (!els.tileFallback.hidden) {
          els.tileFallback.hidden = true;
          els.mapPanel.classList.remove("tiles-failed");
          els.mapChip.textContent = "拖动缩放地图 · 点击价格气泡查看酒店";
        }
      });
      tileLayer.addTo(map);
      setTimeout(() => {
        if (!anyTileLoaded) markTilesFailed("地图瓦片暂时不可用，已切换为雷达底图。酒店点位与列表仍然可用。");
      }, 8000);
    } catch (err) {
      console.warn("map init failed", err);
      markTilesFailed("地图初始化失败，酒店列表仍可正常使用。");
    }
  }

  function markTilesFailed(message) {
    els.mapPanel.classList.add("tiles-failed");
    els.tileFallback.hidden = false;
    const sub = els.tileFallback.querySelector(".fallback-sub");
    if (sub && message) sub.textContent = message;
    els.mapChip.textContent = "雷达视图 · 酒店点位与查询半径";
  }

  function drawMap() {
    if (!state.map) return;
    const anchor = state.anchor;
    if (!anchor || !Number.isFinite(Number(anchor.lat)) || !Number.isFinite(Number(anchor.lng))) return;
    const center = [Number(anchor.lat), Number(anchor.lng)];

    if (state.centerMarker) state.map.removeLayer(state.centerMarker);
    state.centerMarker = L.marker(center, {
      icon: L.divIcon({ className: "center-icon-wrap", html: '<div class="center-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
      keyboard: false,
      title: String(anchor.name || "查询中心"),
    }).addTo(state.map);

    if (state.circle) state.map.removeLayer(state.circle);
    state.circle = L.circle(center, {
      radius: state.radius,
      color: "#0f4a45",
      weight: 2,
      opacity: 0.62,
      dashArray: "7 7",
      fillColor: "#0f4a45",
      fillOpacity: 0.055,
      interactive: false,
    }).addTo(state.map);

    state.markersLayer.clearLayers();
    state.markerIndex.clear();
    closeLocateTooltip();
    state.hotels.forEach((hotel) => {
      if (!Number.isFinite(Number(hotel.lat)) || !Number.isFinite(Number(hotel.lng))) return;
      const available = !!hotel.available;
      const priceText = Number(hotel.price) > 0 ? `¥${fmtNum(hotel.price)}` : "询价";
      const icon = L.divIcon({
        className: "price-marker-wrap",
        html: `<div class="price-marker${available ? "" : " unavailable"}" title="${esc(hotel.name)}">${priceText}</div>`,
        iconSize: [1, 1],
        iconAnchor: [0, 0],
      });
      const marker = L.marker([Number(hotel.lat), Number(hotel.lng)], { icon, riseOnHover: true, keyboard: false });
      marker.options.priceValue = Number(hotel.price) || 0;
      marker.bindTooltip(
        `<div class="map-tip-name">${esc(hotel.name)}</div><div class="map-tip-meta">${priceText} · ${fmtDist(hotel.distance_m)}</div>`,
        { direction: "top", offset: [0, -7], opacity: 1, className: "hotel-map-tip" }
      );
      marker.on("click", () => {
        selectHotel(hotel.uid);
        openDetail(hotel.uid);
      });
      marker.addTo(state.markersLayer);
      state.markerIndex.set(hotel.uid, marker);
    });

    const mapKey = `${center[0]}|${center[1]}|${state.radius}`;
    if (mapKey !== state.mapKey) {
      state.mapKey = mapKey;
      setTimeout(() => {
        if (!state.map) return;
        state.map.setView(center, zoomForRadius(state.radius), { animate: false });
        state.map.invalidateSize();
      }, 60);
    }

    els.mapChip.textContent = `以 ${anchor.name || "地标"} 为圆心 · ${fmtDist(state.radius)} · ${state.hotels.length} 个点位`;
    els.mapLegend.hidden = false;
    updateMarkerSelection();
  }

  function selectHotel(uid) {
    state.selectedUid = uid;
    document.querySelectorAll(".hotel-card").forEach((card) => {
      card.classList.toggle("selected", card.dataset.uid === uid);
    });
    updateMarkerSelection();
    const card = [...document.querySelectorAll(".hotel-card")].find((item) => item.dataset.uid === uid);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closeLocateTooltip() {
    if (!state.locateMarker) return;
    state.locateMarker.closeTooltip();
    state.locateMarker = null;
  }

  function locateHotel(uid) {
    const hotel = state.hotels.find((item) => item.uid === uid);
    if (!hotel) return;
    const lat = Number(hotel.lat);
    const lng = Number(hotel.lng);
    selectHotel(uid);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      toast("这家酒店暂无地图坐标");
      return;
    }
    if (!state.map) {
      toast("地图不可用，已在列表中定位该酒店");
      return;
    }
    if (window.innerWidth <= 960) {
      els.mapPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const marker = state.markerIndex.get(uid);
    if (state.locateMarker && state.locateMarker !== marker) closeLocateTooltip();
    const reveal = () => {
      state.map.flyTo([lat, lng], 17, { duration: 0.72 });
      updateMarkerSelection();
      if (marker) {
        marker.setZIndexOffset(1500);
        marker.openTooltip();
        state.locateMarker = marker;
      }
    };
    if (marker && state.markersLayer && typeof state.markersLayer.getVisibleParent === "function") {
      const visibleParent = state.markersLayer.getVisibleParent(marker);
      if (visibleParent && visibleParent !== marker && typeof state.markersLayer.zoomToShowLayer === "function") {
        state.markersLayer.zoomToShowLayer(marker, reveal);
      } else {
        reveal();
      }
    } else {
      reveal();
    }
    toast(`已定位：${hotel.name}`);
  }

  function updateMarkerSelection() {
    state.markerIndex.forEach((marker, uid) => {
      const element = marker.getElement();
      const bubble = element ? element.querySelector(".price-marker") : null;
      if (bubble) bubble.classList.toggle("selected", uid === state.selectedUid);
      marker.setZIndexOffset(uid === state.selectedUid ? 1200 : 0);
    });
  }

  /* ---------------- detail drawer ---------------- */
  function buildGallery(hotel, reviews) {
    const gallery = [];
    const seen = new Set();
    const add = (url, caption) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      gallery.push({ url, caption });
    };
    (hotel.photos || []).slice(0, 12).forEach((url) => add(url, "酒店实拍"));
    reviews.forEach((review) => {
      (review.photos || []).slice(0, 4).forEach((url) => add(url, `住客实拍 · ${review.user || "匿名住客"}`));
    });
    return gallery;
  }

  function sectionHtml(number, title, note, body) {
    return `<section class="d-section">
      <div class="d-section-head">
        <div class="d-section-title"><span class="idx">${String(number).padStart(2, "0")}</span>${title}</div>
        ${note ? `<span class="d-section-note">${esc(note)}</span>` : ""}
      </div>
      ${body}
    </section>`;
  }

  function renderDrawer(hotel) {
    const h = hotel;
    const reviews = Array.isArray(h.reviews) ? h.reviews : [];
    const gallery = buildGallery(h, reviews);
    state.detailGallery = gallery;

    const heroUrl = h.cover || (h.photos || [])[0] || "";
    const badges = [];
    if (h.level) badges.push(`<span class="d-badge">${esc(h.level)}</span>`);
    else if (h.category) badges.push(`<span class="d-badge">${esc(h.category)}</span>`);
    if (h.available) badges.push('<span class="d-badge accent">今晚可订</span>');
    else badges.push('<span class="d-badge">暂不可订</span>');

    const metaBits = [];
    if (h.city && h.district) metaBits.push(`${h.city}${h.district}`);
    else if (h.city) metaBits.push(h.city);
    metaBits.push(`距查询中心 ${fmtDist(h.distance_m)}`);
    if (h.review_total) metaBits.push(`${fmtNum(h.review_total)} 条评价`);
    if (h.landmark_eta) metaBits.push(h.landmark_eta);

    const score = Number(h.rating) > 0 ? Number(h.rating).toFixed(1) : "—";
    const stars = starText(h.level) || "";
    const subScores = [];
    if (h.rating_facility > 0) subScores.push(`设施 ${Number(h.rating_facility).toFixed(1)}`);
    if (h.rating_hygiene > 0) subScores.push(`卫生 ${Number(h.rating_hygiene).toFixed(1)}`);
    if (h.rating_service > 0) subScores.push(`服务 ${Number(h.rating_service).toFixed(1)}`);

    const price = Number(h.price) > 0
      ? `<div class="d-price"><span class="yen">¥</span>${fmtNum(h.price)}<span class="per">起 / 晚</span></div>
         <div class="d-price-note">公开实时起价 · 实际价格与房量以酒店为准</div>`
      : `<div class="d-price"><span class="ask">暂无公开起价</span></div>
         <div class="d-price-note">可致电酒店询价</div>`;

    const availability = h.available
      ? `<div><b>● 今晚可订</b></div><div>房型价格来自公开页面</div>`
      : `<div><span class="soldout">● ${h.fullroom ? "今晚满房" : "今晚暂不可订"}</span></div><div>可查看其他日期或附近酒店</div>`;

    const actions = [];
    if (h.phone) {
      actions.push(`<a class="d-btn primary" href="tel:${esc(String(h.phone).replace(/[^\d+\-() ]/g, ""))}">${SVG.phone}拨打电话</a>`);
    }
    actions.push(`<button type="button" class="d-btn" data-action="show-map">${SVG.map}地图定位</button>`);
    actions.push(`<button type="button" class="d-btn" data-action="copy-address">${SVG.copy}复制地址</button>`);

    const facts = [
      ["入住", h.checkin || "以酒店为准"],
      ["离店", h.checkout || "以酒店为准"],
      ["酒店类型", h.level || h.category || "酒店"],
      ["品牌", h.brand || "独立酒店"],
      ["开业 / 装修", [h.open_year, h.renovation].filter(Boolean).join(" · ") || "未公开"],
      ["联系电话", h.phone || "未公开"],
    ];
    if (h.landmark_eta) facts.push(["地标距离", h.landmark_eta]);
    const factsHtml = `<div class="d-facts">${facts.map(([key, value]) => `
      <div class="d-fact"><div class="k">${esc(key)}</div><div class="v">${esc(value)}</div></div>`).join("")}</div>`;

    const intro = String(h.intro || "").trim();
    const introClamped = intro.length > 180;
    const introHtml = intro
      ? `<p class="d-intro${introClamped ? " clamped" : ""}">${esc(intro)}</p>
         ${introClamped ? '<button type="button" class="text-toggle" data-action="toggle-intro">展开全文</button>' : ""}`
      : `<p class="d-intro">这家酒店暂未提供公开简介。下面整理了公开的入住信息、房型和住客评论。</p>`;

    const rooms = Array.isArray(h.rooms) ? h.rooms : [];
    const realCount = rooms.filter((room) => !room.is_reference).length;
    const roomsHtml = rooms.length
      ? `<div class="room-grid">${rooms.map((room) => {
          const isRef = !!room.is_reference;
          const roomPrice = Number(room.price) > 0
            ? `<div class="room-price"><span class="yen">¥</span>${fmtNum(room.price)}<small>/晚起</small></div>`
            : `<div class="room-price"><span class="ask">询价</span></div>`;
          const specs = [];
          if (room.area) specs.push(`${room.area}㎡`);
          if (room.bed) specs.push(room.bed);
          if (room.max_guests) specs.push(`可住 ${room.max_guests} 人`);
          if (room.breakfast) specs.push(room.breakfast);
          return `<article class="room-card${isRef ? "" : " real"}">
            <div class="room-top">
              <div class="room-name">${esc(room.name)}</div>
              <span class="room-badge">${esc(room.badge || (isRef ? "参考套房" : "实时在售"))}</span>
            </div>
            ${roomPrice}
            <div class="room-specs">${specs.map((text) => `<span>${esc(text)}</span>`).join("")}</div>
            <div class="room-policy">${esc(room.cancel || "取消政策以酒店为准")}</div>
          </article>`;
        }).join("")}</div>
        <div class="room-note">本页展示 ${realCount} 个公开实时在售房型与 ${Math.max(0, rooms.length - realCount)} 个参考套房。参考房型由酒店等级与公开起价估算，面积、早餐、床型与取消政策仅供参考，实际以酒店为准。</div>`
      : `<div class="room-note">该酒店暂未公开房型信息，可致电酒店咨询今日可订房型。</div>`;

    const facilityChips = (h.facilities || []).slice(0, 14);
    const tagChips = (h.tags || []).slice(0, 10);
    const facilitiesHtml = facilityChips.length || tagChips.length
      ? `<div class="facility-chips">${facilityChips.map((item) => `<span>${esc(item)}</span>`).join("")}</div>
         ${tagChips.length ? `<div class="tag-chips" style="margin-top:8px">${tagChips.map((item) => `<span>${esc(item)}</span>`).join("")}</div>` : ""}`
      : `<p class="d-intro">暂未提取到公开设施标签。</p>`;

    const galleryChips = gallery.slice(0, 9);
    const galleryHtml = gallery.length
      ? `<div class="gallery-grid">${galleryChips.map((item, index) => {
          const overlay = index === 8 && gallery.length > 9
            ? `<span class="g-more">+${gallery.length - 9}</span>` : "";
          const caption = index < 9 ? `<span class="g-caption">${esc(item.caption)}</span>` : "";
          return `<button type="button" class="gallery-item" data-action="gallery" data-index="${index}" aria-label="查看图片 ${index + 1}">
            ${imgTag(item.url, item.caption)}${overlay}${caption}
          </button>`;
        }).join("")}</div>
        <div class="more-wrap"><span class="d-section-note">共 ${gallery.length} 张 · 点击查看大图</span></div>`
      : `<p class="d-intro">该酒店暂未提供实拍图片。</p>`;

    const reviewHtml = reviews.length
      ? reviews.map((review, index) => {
          const user = String(review.user || "匿名住客");
          const initial = Array.from(user)[0] || "栖";
          const text = String(review.text || "");
          const clamp = text.length > 120;
          const photos = (review.photos || []).slice(0, 4).map((url) => {
            const galleryIndex = gallery.findIndex((item) => item.url === url);
            return galleryIndex >= 0
              ? `<button type="button" data-action="gallery" data-index="${galleryIndex}" aria-label="查看住客实拍"><img src="${proxyImg(url)}" alt="住客实拍" loading="lazy" onerror="this.onerror=null;this.parentElement.style.display='none'"></button>`
              : "";
          }).join("");
          return `<article class="review-card">
            <div class="review-head">
              <span class="review-avatar">${esc(initial)}</span>
              <span class="review-user">${esc(user)}</span>
              ${Number(review.rating) > 0 ? `<span class="review-score">${Number(review.rating).toFixed(1)} 分</span>` : ""}
              <span class="review-date">${esc(review.date || "")}</span>
            </div>
            <p class="review-text${clamp ? " clamped" : ""}">${esc(text)}</p>
            ${clamp ? `<button type="button" class="text-toggle" data-action="expand-review" data-review="${index}">展开全文</button>` : ""}
            ${photos ? `<div class="review-photos">${photos}</div>` : ""}
          </article>`;
        }).join("")
      : `<p class="d-intro">暂无公开评论。可以到店后参考其他住客的分享。</p>`;

    const policies = [];
    if (h.notices) policies.push(["重要通知", h.notices]);
    if (h.pet_policy) policies.push(["宠物政策", h.pet_policy]);
    if (h.applicability) policies.push(["适用人群", h.applicability]);
    const policyHtml = policies.length
      ? `<div class="d-policy-list">${policies.map(([key, value]) => `
          <div class="d-policy"><div class="k">${esc(key)}</div><div class="v">${esc(value)}</div></div>`).join("")}</div>`
      : "";

    let number = 0;
    const sections = [];
    sections.push(sectionHtml(++number, "酒店速览", "公开资料整理", introHtml + factsHtml));
    sections.push(sectionHtml(++number, "房型与套房", `${rooms.length} 个房型`, roomsHtml));
    if (facilityChips.length || tagChips.length) sections.push(sectionHtml(++number, "设施与标签", "来自公开页面", facilitiesHtml));
    sections.push(sectionHtml(++number, "住客评论", reviews.length ? `精选 ${reviews.length} 条${h.review_total > reviews.length ? ` / 共 ${fmtNum(h.review_total)} 条` : ""}` : "暂无", reviewHtml));
    sections.push(sectionHtml(++number, "实拍图集", "酒店与住客实拍", galleryHtml));
    if (policies.length) sections.push(sectionHtml(++number, "入住政策", "以酒店实际政策为准", policyHtml));

    return `<div class="d-hero">
      ${imgTag(heroUrl, h.name, true)}
      <div class="d-hero-badges">${badges.join("")}</div>
      <button class="d-close" type="button" data-action="close" aria-label="关闭详情">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
      <div class="d-hero-foot">
        <div class="d-kicker">STAYPOINT / HOTEL DETAIL</div>
        <h2>${esc(h.name)}</h2>
        <div class="d-hero-meta">${metaBits.map(esc).join('<span class="dot"></span>')}</div>
      </div>
    </div>
    <div class="d-content">
      <div class="d-rating-row">
        <div class="d-score">${score}<small>/ 5</small></div>
        <div>
          <div class="d-stars">${esc(stars)}</div>
          <div class="d-rating-meta">${subScores.length ? subScores.map(esc).join(" · ") : "暂无细分评分"}${h.rating_src ? ` · ${esc(sourceShort(h.rating_src))}` : ""}</div>
        </div>
      </div>
      <div class="d-price-row">
        <div>${price}</div>
        <div class="d-price-side">${availability}</div>
      </div>
      <div class="d-actions">${actions.join("")}</div>
      ${sections.join("")}
      <div class="d-disclaimer">${esc(state.disclaimer || "酒店名称、地址、评分、评论、图片与实时起价来自百度地图公开页面。参考房型与估算价格仅供参考，实际以酒店为准。")}${state.generatedAt ? ` 数据时间：${esc(state.generatedAt)}。` : ""}</div>
    </div>`;
  }

  function openDetail(uid) {
    const hotel = state.hotels.find((item) => item.uid === uid);
    if (!hotel) return;
    closeLocateTooltip();
    const wasOpen = els.drawer.classList.contains("open");
    if (!wasOpen) state.drawerReturnFocus = document.activeElement;
    clearTimeout(state.drawerCloseTimer);
    state.drawerUid = uid;
    els.drawerInner.innerHTML = renderDrawer(hotel);
    els.drawerInner.scrollTop = 0;
    els.drawerScrim.hidden = false;
    els.drawer.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => els.drawer.classList.add("open"));
    syncBodyLock();
    selectHotel(uid);
    setTimeout(() => {
      const closeBtn = els.drawerInner.querySelector(".d-close");
      if (closeBtn && els.drawer.classList.contains("open")) closeBtn.focus();
    }, 80);
  }

  function closeDetail(skipFocus = false) {
    if (!els.drawer.classList.contains("open")) return;
    els.drawer.classList.remove("open");
    els.drawer.setAttribute("aria-hidden", "true");
    state.drawerCloseTimer = setTimeout(() => {
      if (!els.drawer.classList.contains("open")) els.drawerScrim.hidden = true;
    }, 360);
    syncBodyLock();
    if (!skipFocus) {
      const uid = state.drawerUid;
      const target = [...document.querySelectorAll(".hotel-card")].find((card) => card.dataset.uid === uid) || state.drawerReturnFocus;
      if (target && typeof target.focus === "function" && document.contains(target)) {
        setTimeout(() => target.focus(), 60);
      }
    }
    state.drawerUid = null;
  }

  function onDrawerClick(event) {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const hotel = state.hotels.find((item) => item.uid === state.drawerUid);
    if (action === "close") {
      closeDetail();
    } else if (action === "toggle-intro") {
      const intro = els.drawerInner.querySelector(".d-intro");
      if (!intro) return;
      const clamped = intro.classList.toggle("clamped");
      btn.textContent = clamped ? "展开全文" : "收起";
    } else if (action === "expand-review") {
      const card = btn.closest(".review-card");
      const text = card ? card.querySelector(".review-text") : null;
      if (text) text.classList.remove("clamped");
      btn.remove();
    } else if (action === "gallery") {
      openLightbox(Number(btn.dataset.index) || 0);
    } else if (action === "show-map") {
      if (!hotel) return;
      closeDetail(true);
      locateHotel(hotel.uid);
    } else if (action === "copy-address") {
      if (!hotel) return;
      copyText(hotel.address || hotel.name, "地址已复制");
    }
  }

  async function copyText(text, successMessage) {
    try {
      await navigator.clipboard.writeText(text);
      toast(successMessage || "已复制");
    } catch (_) {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
        toast(successMessage || "已复制");
      } catch (err) {
        toast("复制失败，请手动选择文本");
      }
    }
  }

  /* ---------------- lightbox ---------------- */
  function openLightbox(index) {
    const items = state.detailGallery || [];
    if (!items.length) return;
    state.lightboxIndex = Math.max(0, Math.min(index, items.length - 1));
    state.lightboxReturnFocus = document.activeElement;
    els.lightbox.hidden = false;
    syncBodyLock();
    updateLightbox();
    els.lightboxClose.focus();
  }

  function updateLightbox() {
    const items = state.detailGallery || [];
    if (!items.length) return;
    const item = items[state.lightboxIndex];
    els.lightboxImg.src = proxyImg(item.url);
    els.lightboxImg.alt = item.caption || "酒店图片";
    els.lightboxCaption.textContent = `${state.lightboxIndex + 1} / ${items.length}${item.caption ? " · " + item.caption : ""}`;
    const many = items.length > 1;
    els.lightboxPrev.hidden = !many;
    els.lightboxNext.hidden = !many;
  }

  function navLightbox(delta) {
    const items = state.detailGallery || [];
    if (items.length < 2) return;
    state.lightboxIndex = (state.lightboxIndex + delta + items.length) % items.length;
    updateLightbox();
  }

  function closeLightbox(skipFocus = false) {
    if (els.lightbox.hidden) return;
    els.lightbox.hidden = true;
    els.lightboxImg.removeAttribute("src");
    syncBodyLock();
    if (!skipFocus && state.lightboxReturnFocus && document.contains(state.lightboxReturnFocus)) {
      state.lightboxReturnFocus.focus();
    }
  }

  /* ---------------- about ---------------- */
  function openAbout() {
    state.aboutReturnFocus = document.activeElement;
    els.aboutModal.hidden = false;
    syncBodyLock();
    els.aboutClose.focus();
  }

  function closeAbout() {
    if (els.aboutModal.hidden) return;
    els.aboutModal.hidden = true;
    syncBodyLock();
    if (state.aboutReturnFocus && document.contains(state.aboutReturnFocus)) state.aboutReturnFocus.focus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
