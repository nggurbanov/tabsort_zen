// Advanced Tab Sort for Zen (Sine mod)
// AI-backed tab grouping with Advanced Tab Groups interop.
(() => {
  const MOD_ID = "advanced-tab-sort";
  if (window.AdvancedTabSort) {
    console.info(`[${MOD_ID}] already loaded`);
    return;
  }

  const DEFAULT_PREFS = {
    provider: "openai",
    includePageText: false,
    maxCharsPerTab: 800,
    maxGroups: 8,
    mergeExisting: true,
    renameGroups: false,
    dryRun: false,
    autoSortOnNewTabs: false,
    burstThreshold: 5,
    idleDelayMs: 800,
    timeoutMs: 15000,
    logLevel: "info",
    openai: {
      apiKey: "",
      baseUrl: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o-mini",
      temperature: 0.2,
    },
    gemini: {
      apiKey: "",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
      model: "gemini-1.5-pro",
      temperature: 0.2,
    },
    ollama: {
      host: "http://localhost:11434",
      model: "llama3",
      temperature: 0.2,
    },
    firefoxLocal: {
      model: "zen-local-llm",
      temperature: 0.0,
    },
  };

  const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
  let prefsCache = null;
  const BUTTON_ID = "advanced-tab-sort-button";
  const TABSTRIP_BUTTON_ID = "advanced-tab-sort-tabstrip-button";
  const STYLE_ID = "advanced-tab-sort-style";
  const CMD_ID = "cmd_advancedTabSort";
  const HOTKEY = { key: "S", altKey: true, shiftKey: true };
  const FLOATING_BUTTON_ID = "advanced-tab-sort-fab";

  const log = (level, ...args) => {
    try {
      const prefs = loadPrefs();
      const current = LOG_LEVELS[prefs.logLevel] ?? LOG_LEVELS.info;
      if ((LOG_LEVELS[level] ?? 0) <= current) {
        console[level](`[${MOD_ID}]`, ...args);
      }
    } catch (e) {
      console.error(`[${MOD_ID}] logger failure`, e);
    }
  };

  const unflattenPrefs = (obj) => {
    const out = {};
    Object.entries(obj || {}).forEach(([key, val]) => {
      if (!key.includes(".")) {
        out[key] = val;
        return;
      }
      const parts = key.split(".");
      let cur = out;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === parts.length - 1) {
          cur[part] = val;
        } else {
          cur[part] = cur[part] || {};
          cur = cur[part];
        }
      }
    });
    return out;
  };

  const deepMerge = (base, extra) => {
    const out = Array.isArray(base) ? [...base] : { ...base };
    Object.entries(extra || {}).forEach(([k, v]) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = deepMerge(out[k] || {}, v);
      } else {
        out[k] = v;
      }
    });
    return out;
  };

  const loadPrefs = () => {
    if (prefsCache) return prefsCache;
    try {
      const fromSine = window?.Sine?.getPreferences?.(MOD_ID);
      const normalized = unflattenPrefs(fromSine || {});
      prefsCache = deepMerge(DEFAULT_PREFS, normalized);
    } catch (e) {
      console.warn(`[${MOD_ID}] falling back to default prefs`, e);
      prefsCache = { ...DEFAULT_PREFS };
    }
    return prefsCache;
  };

  const debounce = (fn, wait) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  };

  const waitForBrowser = () =>
    new Promise((resolve) => {
      if (window.gBrowser) return resolve(window.gBrowser);
      const check = () => (window.gBrowser ? resolve(window.gBrowser) : setTimeout(check, 100));
      check();
    });

  const sanitizeGroupName = (name) => {
    if (!name) return "Other";
    return String(name).trim().slice(0, 64) || "Other";
  };

  const collectTabs = (includeText, maxChars) => {
    const tabs = [];
    for (const tab of gBrowser.tabs) {
      const url = tab.linkedBrowser?.currentURI?.spec || tab.linkedBrowser?.currentURI?.displaySpec || "";
      const title = tab.label || tab.linkedBrowser?.contentTitle || url;
      const entry = {
        id: tab.linkedBrowser?.outerWindowID || tab._uniqueID || Math.random().toString(36).slice(2),
        tab,
        title,
        url,
        pinned: tab.pinned === true,
      };
      if (includeText && !tab.pinned) {
        try {
          const doc = tab.linkedBrowser?.contentDocument;
          const text = doc?.body?.innerText || "";
          entry.text = text.slice(0, maxChars);
        } catch (e) {
          log("debug", "content read blocked for tab", title, e);
        }
      }
      tabs.push(entry);
    }
    return tabs;
  };

  const domainHeuristic = (tabs, maxGroups) => {
    const groups = new Map();
    for (const t of tabs) {
      if (t.pinned) continue;
      let host = "";
      try {
        host = new URL(t.url).hostname || "misc";
      } catch (e) {
        host = "misc";
      }
      const key = host || "misc";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t.id);
    }
    const arr = Array.from(groups.entries()).slice(0, maxGroups).map(([name, ids]) => ({
      name: sanitizeGroupName(name),
      tabs: ids,
    }));
    return { groups: arr, source: "heuristic" };
  };

  const buildPrompt = (tabs, prefs) => {
    const trimmedTabs = tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      text: prefs.includePageText ? t.text || "" : undefined,
    }));
    const payload = JSON.stringify({ tabs: trimmedTabs, maxGroups: prefs.maxGroups });
    return [
      "You are grouping browser tabs into thematic groups.",
      "Return ONLY minified JSON like:",
      '{"groups":[{"name":"<group>","tabs":["<tabId>"]}]}',
      "Rules:",
      "- Use at most maxGroups.",
      "- Do not invent tab ids.",
      "- Prefer short group names.",
      "- If unsure, put in Other.",
      "Input:",
      payload,
    ].join("\n");
  };

  const parseModelGroups = (text) => {
    if (!text) throw new Error("empty response");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("no JSON object found");
    const json = text.slice(start, end + 1);
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed.groups)) throw new Error("missing groups");
    return {
      groups: parsed.groups
        .map((g) => ({
          name: sanitizeGroupName(g.name || "Other"),
          tabs: Array.isArray(g.tabs) ? g.tabs : [],
        }))
        .filter((g) => g.tabs.length),
      source: "model",
    };
  };

  const ensureCommand = () => {
    try {
      const commandSet =
        document.querySelector("commandset#zenCommandSet") ||
        document.querySelector("commandset");
      if (!commandSet) return;
      if (commandSet.querySelector(`#${CMD_ID}`)) return;
      const fragment = window.MozXULElement?.parseXULToFragment
        ? window.MozXULElement.parseXULToFragment(`<command id="${CMD_ID}"/>`)
        : null;
      const cmd = fragment?.firstChild || document.createElement("command");
      cmd.id = CMD_ID;
      cmd.addEventListener("command", () => sortTabs());
      commandSet.appendChild(cmd);
    } catch (e) {
      log("warn", "Failed to ensure command", e);
    }
  };

  const registerButton = () => {
    try {
      if (!window.CustomizableUI) return;
      if (CustomizableUI.getWidget?.(BUTTON_ID)?.id === BUTTON_ID) return;
      CustomizableUI.createWidget({
        id: BUTTON_ID,
        defaultArea: CustomizableUI.AREA_NAVBAR,
        label: "AI Sort Tabs",
        tooltiptext: "AI sort tabs into groups",
        onCommand: () => sortTabs(),
      });
    } catch (e) {
      log("warn", "Failed to register toolbar button", e);
    }
  };

  const buildTabstripButton = () => {
    const icon = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M19 6l-2 12-6 2-6-2 2-12 6-2 6 2z" stroke="currentColor" stroke-width="1.5" />
        <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `;
    const markup = `
      <toolbarbutton id="${TABSTRIP_BUTTON_ID}"
        class="advanced-tab-sort-button toolbarbutton-1 chromeclass-toolbar-additional"
        command="${CMD_ID}"
        tooltiptext="AI sort tabs into groups">
        <hbox class="toolbarbutton-box" align="center">
          <hbox class="ats-icon" align="center" pack="center">${icon}</hbox>
          <label class="toolbarbutton-text" value="Sort" crop="right"/>
        </hbox>
      </toolbarbutton>
    `;
    let btn;
    if (window.MozXULElement?.parseXULToFragment) {
      btn = window.MozXULElement.parseXULToFragment(markup).firstChild;
    } else {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = markup;
      btn = wrapper.firstElementChild;
    }
    // Ensure click works even if the XUL command binding is unavailable.
    if (btn) {
      btn.addEventListener("command", () => sortTabs());
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        sortTabs();
      });
    }
    return btn;
  };

  const injectStyles = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${TABSTRIP_BUTTON_ID} {
        min-height: 26px;
        margin-inline-start: 6px;
        border-radius: 8px;
        padding-inline: 8px 10px;
        color: var(--zen-colors-primary-foreground, currentColor);
        background: color-mix(in srgb, currentColor 8%, transparent);
        border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
        transition: background 120ms ease, border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;
      }
      #${TABSTRIP_BUTTON_ID}:hover {
        background: color-mix(in srgb, currentColor 14%, transparent);
        border-color: color-mix(in srgb, currentColor 20%, transparent);
        box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 12%, transparent);
      }
      #${TABSTRIP_BUTTON_ID}:active {
        transform: translateY(1px);
        background: color-mix(in srgb, currentColor 18%, transparent);
      }
      #${TABSTRIP_BUTTON_ID} .ats-icon {
        margin-inline-end: 6px;
        width: 16px;
        height: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      #${FLOATING_BUTTON_ID} {
        position: fixed;
        bottom: 18px;
        right: 18px;
        z-index: 999999;
        border-radius: 999px;
        padding: 10px 14px;
        font-size: 13px;
        font-weight: 600;
        color: var(--zen-colors-primary-foreground, #fff);
        background: color-mix(in srgb, currentColor 18%, #111 60%);
        border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
        box-shadow: 0 6px 18px rgba(0,0,0,0.2);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease;
      }
      #${FLOATING_BUTTON_ID}:hover {
        transform: translateY(-1px);
        box-shadow: 0 8px 20px rgba(0,0,0,0.25);
      }
      #${FLOATING_BUTTON_ID}:active {
        transform: translateY(1px);
      }
    `;
    document.documentElement.appendChild(style);
    window.addEventListener(
      "unload",
      () => document.getElementById(STYLE_ID)?.remove(),
      { once: true }
    );
  };

  const findTabstripHost = () => {
    const periphery = document.getElementById("tabbrowser-arrowscrollbox-periphery");
    const newTab = document.getElementById("new-tab-button");
    const tabsToolbar = document.getElementById("TabsToolbar");
    const separators = Array.from(document.querySelectorAll(".pinned-tabs-container-separator"));
    const tabstrip = document.getElementById("tabbrowser-tabs");
    const vertical = document.querySelector("#vertical-tabs, .vertical-tabs, #zen-vertical-tabs");
    return periphery || newTab?.parentNode || tabsToolbar || separators?.[0] || vertical || tabstrip;
  };

  const addTabstripButton = () => {
    const inject = () => {
      try {
        if (document.getElementById(TABSTRIP_BUTTON_ID)) return true;
        const host = findTabstripHost();

        if (!host) {
          log("debug", "Tabstrip host not found; retrying later");
          return false;
        }
        const btn = buildTabstripButton();
        if (!btn) return false;
        const anchor = document.getElementById("new-tab-button");
        host.insertBefore(
          btn,
          anchor && anchor.parentNode === host ? anchor.nextSibling : null
        );
        injectStyles();
        return true;
      } catch (e) {
        log("warn", "Failed to add tabstrip button", e);
        return false;
      }
    };
    const retry = () => {
      if (inject()) return;
      setTimeout(retry, 250);
    };
    retry();
  };

  const startButtonObserver = () => {
    const observer = new MutationObserver(() => {
      if (document.getElementById(TABSTRIP_BUTTON_ID)) return;
      const host = findTabstripHost();
      if (host) addTabstripButton();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener(
      "unload",
      () => observer.disconnect(),
      { once: true }
    );
  };

  const addFloatingButton = () => {
    if (document.getElementById(FLOATING_BUTTON_ID)) return;
    injectStyles();
    const btn = document.createElement("button");
    btn.id = FLOATING_BUTTON_ID;
    btn.setAttribute("title", "AI sort tabs into groups");
    btn.textContent = "Sort Tabs";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      sortTabs();
    });
    const host = document.body || document.documentElement;
    if (host) host.appendChild(btn);
    window.addEventListener(
      "unload",
      () => document.getElementById(FLOATING_BUTTON_ID)?.remove(),
      { once: true }
    );
  };

  const registerHotkey = () => {
    const handler = (evt) => {
      if (
        evt.key?.toUpperCase() === HOTKEY.key &&
        !!evt.altKey === HOTKEY.altKey &&
        !!evt.shiftKey === HOTKEY.shiftKey &&
        !evt.ctrlKey &&
        !evt.metaKey
      ) {
        const target = evt.target;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
          return;
        }
        evt.preventDefault();
        sortTabs();
      }
    };
    window.addEventListener("keydown", handler, false);
  };

  const fetchWithTimeout = async (url, options, timeoutMs) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return res;
    } finally {
      clearTimeout(t);
    }
  };

  const providerAdapters = {
    async openai({ tabs, prefs, prompt }) {
      const cfg = prefs.openai;
      if (!cfg.apiKey) throw new Error("OpenAI API key missing");
      const body = {
        model: cfg.model,
        temperature: cfg.temperature,
        messages: [{ role: "user", content: prompt }],
      };
      const res = await fetchWithTimeout(
        cfg.baseUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(body),
        },
        prefs.timeoutMs
      );
      if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      return parseModelGroups(text);
    },
    async gemini({ tabs, prefs, prompt }) {
      const cfg = prefs.gemini;
      if (!cfg.apiKey) throw new Error("Gemini API key missing");
      const url = `${cfg.baseUrl}/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: cfg.temperature ?? 0.2 },
      };
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        prefs.timeoutMs
      );
      if (!res.ok) throw new Error(`Gemini error ${res.status}`);
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
      return parseModelGroups(text);
    },
    async ollama({ tabs, prefs, prompt }) {
      const cfg = prefs.ollama;
      const url = `${cfg.host.replace(/\/$/, "")}/api/chat`;
      const body = {
        model: cfg.model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
        options: { temperature: cfg.temperature ?? 0.2 },
      };
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        prefs.timeoutMs
      );
      if (!res.ok) throw new Error(`Ollama error ${res.status}`);
      const data = await res.json();
      const text = data?.message?.content;
      return parseModelGroups(text);
    },
    async "firefox-local"({ tabs, prefs, prompt }) {
      if (window?.zenLocalAI?.labelTabs) {
        const result = await window.zenLocalAI.labelTabs(tabs, prefs, prompt);
        return parseModelGroups(result);
      }
      log("warn", "Firefox local AI hook missing, using heuristic");
      return domainHeuristic(tabs, prefs.maxGroups);
    },
  };

  const detectATG = () => {
    return (
      window.AdvancedTabGroups ||
      window.ATG ||
      window.zenAdvancedTabGroups ||
      null
    );
  };

  const ensureGroup = (atg, name) => {
    if (!atg) return null;
    try {
      if (typeof atg.ensureGroup === "function") return atg.ensureGroup(name);
      if (typeof atg.createGroup === "function") return atg.createGroup(name);
      if (atg.GroupManager?.createGroup) return atg.GroupManager.createGroup(name);
    } catch (e) {
      log("warn", "ATG ensureGroup failed", e);
    }
    return null;
  };

  const assignTabToGroup = (atg, tab, groupName) => {
    if (!atg) return false;
    try {
      if (typeof atg.assignTabToGroup === "function") {
        atg.assignTabToGroup(tab, groupName);
        return true;
      }
      if (atg.GroupManager?.moveTabToGroup) {
        atg.GroupManager.moveTabToGroup(tab, groupName);
        return true;
      }
      if (atg.moveTabToGroup) {
        atg.moveTabToGroup(tab, groupName);
        return true;
      }
    } catch (e) {
      log("warn", "ATG assign failed", e);
    }
    return false;
  };

  const reorderByGroups = (tabs, groups) => {
    // Fallback: cluster tabs together without ATG visuals.
    const movable = tabs.filter((t) => !t.pinned);
    const idToTab = new Map(movable.map((t) => [t.id, t.tab]));
    let insertAt = gBrowser.pinnedTabCount || 0;
    for (const group of groups) {
      for (const id of group.tabs) {
        const tab = idToTab.get(id);
        if (tab) {
          gBrowser.moveTabTo(tab, insertAt);
          insertAt += 1;
        }
      }
    }
  };

  const applyGrouping = (tabs, grouped) => {
    const atg = detectATG();
    const movableTabs = tabs.filter((t) => !t.pinned);
    if (!grouped.groups?.length) {
      log("info", "No groups returned; skipping");
      return { applied: false, reason: "empty" };
    }
    if (atg) {
      log("info", "Applying groups via ATG");
      for (const group of grouped.groups) {
        const name = sanitizeGroupName(group.name);
        ensureGroup(atg, name);
        for (const id of group.tabs) {
          const t = movableTabs.find((x) => x.id === id);
          if (t) assignTabToGroup(atg, t.tab, name);
        }
      }
      if (typeof atg.refresh === "function") atg.refresh();
      return { applied: true, via: "ATG" };
    }
    log("info", "ATG not detected; reordering tabs only");
    reorderByGroups(movableTabs, grouped.groups);
    return { applied: true, via: "reorder" };
  };

  const sortTabs = async (opts = {}) => {
    const prefs = loadPrefs();
    const effective = { ...prefs, ...opts };
    const tabs = collectTabs(effective.includePageText, effective.maxCharsPerTab);
    const prompt = buildPrompt(tabs, effective);
    const providerKey = effective.provider === "firefox-local" ? "firefox-local" : effective.provider;
    const adapter = providerAdapters[providerKey];
    let grouped;
    try {
      if (!adapter) throw new Error(`Unknown provider ${effective.provider}`);
      grouped = await adapter({ tabs, prefs: effective, prompt });
    } catch (e) {
      log("warn", "Provider failed, using heuristic", e);
      grouped = domainHeuristic(tabs, effective.maxGroups);
    }
    grouped.groups = grouped.groups.slice(0, effective.maxGroups);
    if (effective.dryRun || opts.dryRun) {
      log("info", "Dry run grouping", grouped);
      return { grouped, applied: false, dryRun: true };
    }
    const result = applyGrouping(tabs, grouped);
    return { grouped, ...result };
  };

  // Auto-sort on bursts of new tabs if enabled.
  const setupAutoSort = () => {
    const prefs = loadPrefs();
    if (!prefs.autoSortOnNewTabs) return;
    const debounced = debounce(() => sortTabs(), prefs.idleDelayMs);
    let burst = 0;
    const onTabOpen = () => {
      burst += 1;
      if (burst >= prefs.burstThreshold) {
        burst = 0;
        debounced();
      }
    };
    gBrowser.tabContainer.addEventListener("TabOpen", onTabOpen, false);
    window.addEventListener(
      "unload",
      () => gBrowser.tabContainer.removeEventListener("TabOpen", onTabOpen, false),
      { once: true }
    );
  };

  waitForBrowser().then(() => {
    window.AdvancedTabSort = {
      sortNow: sortTabs,
      preview: () => sortTabs({ dryRun: true }),
      getConfig: () => loadPrefs(),
    };
    ensureCommand();
    setupAutoSort();
    registerButton();
    addTabstripButton();
    startButtonObserver();
    addFloatingButton();
    registerHotkey();
    log("info", "Advanced Tab Sort loaded");
  });
})();
