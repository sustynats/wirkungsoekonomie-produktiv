const dimensions = ["Mensch", "Planet", "Demokratie"];
const formatNumber = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 6 });
const formatDate = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "UTC" });
const companyPageSize = 6;
const evidencePageSize = 8;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function publicLink(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? escapeHtml(parsed.href) : "";
  } catch {
    return "";
  }
}

function normalize(value) {
  return value.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replaceAll("ß", "ss").trim();
}

function dateLabel(value) {
  return formatDate.format(new Date(value));
}

function observationValue(observation) {
  const value = Array.isArray(observation.value)
    ? observation.value.map((amount) => formatNumber.format(amount)).join(" bis ")
    : formatNumber.format(observation.value);
  return `${value} ${observation.unit}`;
}

function observationCard(observation, sources) {
  const source = sources[observation.source];
  const period = observation.period
    ? observation.period.map(dateLabel).join(" bis ")
    : observation.year;
  return `<li class="uwp-evidence">
    <div class="uwp-evidence-main">
      <div>
        <h4 tabindex="-1">${escapeHtml(observation.label)}</h4>
        <p class="uwp-muted">${escapeHtml([observation.dimension, period, observation.determination, `Qualität ${observation.quality}`].filter(Boolean).join(" · "))}</p>
      </div>
      <p class="uwp-value">${escapeHtml(observationValue(observation))}</p>
    </div>
    ${observation.facility ? `<p class="uwp-muted">Standort ${escapeHtml(observation.facility.name)}</p>` : ""}
    <div class="uwp-evidence-actions">
      <a href="${publicLink(observation.url)}">${escapeHtml(observation.locator || source.label)}</a>
      <details>
        <summary>Details zur Kennzahl</summary>
        <p>${escapeHtml(observation.note)}</p>
        <p class="uwp-muted">Erfasst am ${dateLabel(observation.retrieved_at)}${observation.source_version ? ` · Quellenstand ${dateLabel(observation.source_version)}` : ""}</p>
        ${observation.original_url ? `<p><a href="${publicLink(observation.original_url)}">Quellenbeleg bei Wikirate</a></p>` : ""}
        ${observation.relationship_url ? `<p><a href="${publicLink(observation.relationship_url)}">Standortzuordnung</a></p>` : ""}
      </details>
    </div>
  </li>`;
}

function dimensionSummary(dimension, observations) {
  const entries = observations.filter((observation) => observation.dimension === dimension);
  const labels = [
    ["report", "Unternehmenskennzahlen"],
    ["prtr", "Standortdaten (PRTR)"],
    ["lobby", "Lobbyregister"],
    ["wikirate", "Historische Sekundärdaten"]
  ];
  const status = labels.filter(([source]) => entries.some((obs) => obs.source === source))
    .map(([, label]) => label).join(" · ");
  return `<li><strong>${dimension}</strong><span>${status || "Datenlage offen"}</span></li>`;
}

function renderComparisons(observations) {
  const groups = new Map();
  for (const observation of observations) {
    if (observation.source !== "report" || !observation.comparable) continue;
    const key = JSON.stringify([observation.indicator_id, observation.url]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(observation);
  }
  if (!groups.size) return "";
  const formatChange = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1, signDisplay: "exceptZero" });
  return `<details class="uwp-details">
    <summary>Berichtete Kennzahlen im Jahresvergleich</summary>
    <div class="uwp-details-body">
      <p>Die Vergleichswerte stammen aus demselben Bericht. Die Ursachen der Veränderung bleiben zu prüfen.</p>
      <ul class="uwp-comparisons">
      ${Array.from(groups.values(), (pair) => {
        const [previous, current] = pair.sort((a, b) => a.year - b.year);
        const change = formatChange.format(current.value - previous.value);
        return `<li>
          <strong>${escapeHtml(current.label)}</strong>
          <span>${previous.year}: ${escapeHtml(observationValue(previous))} · ${current.year}: ${escapeHtml(observationValue(current))}</span>
          <span>Veränderung ${change} ${escapeHtml(current.unit)}</span>
          <a href="${publicLink(current.url)}">Fundstelle</a>
        </li>`;
      }).join("")}
      </ul>
    </div>
  </details>`;
}

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function init(root) {
  const form = root.querySelector("[data-uwp-form]");
  const input = root.querySelector("[data-uwp-search]");
  const coverage = root.querySelector("[data-uwp-coverage]");
  const count = root.querySelector("[data-uwp-count]");
  const status = root.querySelector("[data-uwp-status]");
  const results = root.querySelector("[data-uwp-results]");
  const resultsPanel = root.querySelector("[data-uwp-results-panel]");
  const resultCount = root.querySelector("[data-uwp-result-count]");
  const examples = root.querySelector(".uwp-examples");
  const errorMessage = root.querySelector("[data-uwp-error]");
  const more = root.querySelector("[data-uwp-more]");
  const panel = root.querySelector("[data-uwp-profile]");
  const [universe, snapshot] = await Promise.all([loadJson(root.dataset.universeUrl), loadJson(root.dataset.snapshotUrl)]);
  if (universe.universe_id !== snapshot.universe_id || snapshot.schema_version !== 1) {
    throw new Error("UWP snapshot schema or universe mismatch");
  }

  const byCompany = new Map();
  for (const observation of snapshot.observations) {
    if (!byCompany.has(observation.company_id)) byCompany.set(observation.company_id, []);
    byCompany.get(observation.company_id).push(observation);
  }
  const companies = [...universe.companies].sort((a, b) => a.name.localeCompare(b.name, "de"));
  const companyIndex = new Map(companies.map((company) => [company.company_id, company]));
  const searchable = new Map(companies.map((company) => [company.company_id, normalize([
    company.name, company.legal_name, company.ticker, company.isin, company.lei,
    company.sector, ...(company.index_memberships || []), ...(company.former_names || []),
    ...new Set((byCompany.get(company.company_id) || []).filter((obs) => obs.source === "lobby")
      .map((obs) => obs.locator.split(" · ")[0]))
  ].filter(Boolean).join(" "))]));
  let limit = companyPageSize;
  let selectedId;

  count.textContent = `${byCompany.size} von ${companies.length} Unternehmen mit Quellenwerten`;
  status.textContent = `Letzte Abfrage der Register am ${dateLabel(snapshot.checked_at)}.`;
  form.querySelector("fieldset").disabled = false;

  function matchingCompanies() {
    const terms = normalize(input.value).split(/\s+/).filter(Boolean);
    return companies.filter(({ company_id: id }) => {
      if (coverage.value === "with" && !byCompany.has(id)) return false;
      if (coverage.value === "without" && byCompany.has(id)) return false;
      return terms.every((term) => searchable.get(id).includes(term));
    });
  }

  function renderResults(matches = matchingCompanies()) {
    examples.hidden = Boolean(input.value.trim() || coverage.value);
    resultCount.textContent = matches.length
      ? `${Math.min(limit, matches.length)} von ${matches.length} Treffern`
      : "Keine Treffer. Suche oder Datenfilter ändern.";
    results.innerHTML = matches.slice(0, limit).map((company) => {
      const values = byCompany.get(company.company_id)?.length || 0;
      const dataText = values ? `${values} ${values === 1 ? "Quellenwert" : "Quellenwerte"}` : "Datenlage offen";
      const current = company.company_id === selectedId;
      return `<li><a class="uwp-result-button" data-company-id="${escapeHtml(company.company_id)}"
        href="?unternehmen=${encodeURIComponent(company.company_id)}#profil"${current ? ' aria-current="true"' : ""}>
        <strong>${escapeHtml(company.name)}</strong>
        <small>${escapeHtml([company.ticker, dataText].filter(Boolean).join(" · "))}</small>
      </a></li>`;
    }).join("");
    more.hidden = matches.length <= limit;
  }

  function renderProfile(company, focus = false) {
    panel.hidden = !company;
    selectedId = company?.company_id;
    if (!company) {
      panel.innerHTML = "";
      return;
    }
    const observations = byCompany.get(company.company_id) || [];
    const dimensionsWithData = dimensions.filter((dimension) => observations.some((obs) => obs.dimension === dimension));
    const sourceIds = Object.keys(snapshot.sources).filter((source) => observations.some((obs) => obs.source === source));
    const metadata = [company.ticker, company.sector].filter(Boolean).join(" · ");
    panel.innerHTML = `<section class="uwp-profile-shell" aria-labelledby="uwp-profile-title">
      <div class="uwp-profile-heading">
        <div>
          <h2 id="uwp-profile-title" tabindex="-1">${escapeHtml(company.name)}</h2>
          ${metadata ? `<p class="uwp-muted">${escapeHtml(metadata)}</p>` : ""}
        </div>
        <button class="uwp-text-button" type="button" data-uwp-change-company>Unternehmen wechseln</button>
      </div>
      ${observations.length ? `<ul class="uwp-dimensions" aria-label="Datenlage je Wirkungsdimension">
        ${dimensions.map((dimension) => dimensionSummary(dimension, observations)).join("")}
      </ul>` : `<p>Für dieses Unternehmen liegen in der Beta derzeit keine Quellenwerte vor.</p>`}
      <p class="uwp-muted"><a href="#rechenweg">Gesamtbewertung offen</a></p>
      ${renderComparisons(observations)}
      ${observations.length ? `<div class="uwp-evidence-heading">
        <h3>Kennzahlen und Quellen</h3>
        <a href="#profil-lesen" class="uwp-muted">Datenqualität erklärt</a>
      </div>
      <div class="uwp-profile-filters">
        <div class="uwp-field">
          <label for="uwp-dimension">Wirkungsdimension</label>
          <select id="uwp-dimension">
            <option value="">Alle Dimensionen</option>
            ${dimensionsWithData.map((dimension) => `<option>${dimension}</option>`).join("")}
          </select>
        </div>
        <div class="uwp-field">
          <label for="uwp-source">Quellenart</label>
          <select id="uwp-source">
            <option value="">Alle Quellenarten</option>
            ${sourceIds.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(snapshot.sources[id].role)}</option>`).join("")}
          </select>
        </div>
      </div>
      <p class="uwp-muted" role="status" data-uwp-evidence-count></p>
      <ul class="uwp-evidence-list" data-uwp-evidence></ul>
      <button class="uwp-text-button" type="button" data-uwp-evidence-more hidden>Weitere Werte anzeigen</button>` : ""}
    </section>`;
    if (observations.length) {
      const dimension = panel.querySelector("#uwp-dimension");
      const source = panel.querySelector("#uwp-source");
      const list = panel.querySelector("[data-uwp-evidence]");
      const evidenceCount = panel.querySelector("[data-uwp-evidence-count]");
      const evidenceMore = panel.querySelector("[data-uwp-evidence-more]");
      const sorted = [...observations].sort((a, b) => b.year - a.year || a.quality.localeCompare(b.quality));
      let matching = sorted;
      let shown = 0;

      function addEvidence() {
        const next = matching.slice(shown, shown + evidencePageSize);
        list.insertAdjacentHTML("beforeend", next.map((obs) => observationCard(obs, snapshot.sources)).join(""));
        shown += next.length;
        evidenceCount.textContent = matching.length
          ? `${shown} von ${matching.length} ${matching.length === 1 ? "Wert" : "Werten"}`
          : "Für diese Auswahl liegen keine Quellenwerte vor.";
        evidenceMore.hidden = shown >= matching.length;
      }

      function filterEvidence() {
        matching = sorted.filter((obs) => (!dimension.value || obs.dimension === dimension.value)
          && (!source.value || obs.source === source.value));
        shown = 0;
        list.replaceChildren();
        addEvidence();
      }

      dimension.addEventListener("change", filterEvidence);
      source.addEventListener("change", filterEvidence);
      evidenceMore.addEventListener("click", () => {
        const previousCount = shown;
        addEvidence();
        list.children[previousCount]?.querySelector("h4").focus();
      });
      addEvidence();
    }
    if (focus) {
      panel.querySelector("h2").focus({ preventScroll: true });
      panel.scrollIntoView({ block: "start" });
    }
  }

  function openCompany(id) {
    const company = companyIndex.get(id);
    if (!company) return;
    const url = new URL(window.location.href);
    url.searchParams.set("unternehmen", id);
    url.hash = "profil";
    if (url.href !== window.location.href) history.pushState(null, "", url);
    resultsPanel.hidden = true;
    errorMessage.hidden = true;
    renderProfile(company, true);
  }

  function resetResults() {
    limit = companyPageSize;
    resultsPanel.hidden = false;
    errorMessage.hidden = true;
    renderResults();
  }

  input.addEventListener("input", resetResults);
  coverage.addEventListener("change", resetResults);
  more.addEventListener("click", () => {
    const previousLimit = limit;
    limit += companyPageSize;
    renderResults();
    results.children[previousLimit]?.querySelector("a").focus();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const matches = matchingCompanies();
    if (matches.length === 1) {
      openCompany(matches[0].company_id);
      return;
    }
    resetResults();
    results.querySelector("a")?.focus();
  });
  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-uwp-change-company]")) {
      input.value = "";
      resetResults();
      input.focus();
      return;
    }
    const link = event.target.closest("[data-company-id]");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openCompany(link.dataset.companyId);
  });
  const restore = () => {
    const id = new URLSearchParams(window.location.search).get("unternehmen");
    const company = companyIndex.get(id);
    if (company?.company_id !== selectedId) renderProfile(company);
    if (company) {
      resultsPanel.hidden = true;
      if (window.location.hash === "#profil") panel.scrollIntoView({ block: "start" });
      return;
    }
    resetResults();
    if (id) {
      errorMessage.textContent = "Dieses Profil ist im UWP-100 nicht verfügbar.";
      errorMessage.hidden = false;
    }
  };
  window.addEventListener("popstate", restore);
  restore();
}

const root = document.querySelector("[data-uwp-tool]");
if (root) {
  function openLinkedDetails(fragment) {
    const target = document.getElementById(fragment.slice(1));
    if (target instanceof HTMLDetailsElement && root.contains(target)) target.open = true;
  }

  root.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="#"]');
    if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      openLinkedDetails(link.hash);
    }
  });
  window.addEventListener("hashchange", () => openLinkedDetails(window.location.hash));
  openLinkedDetails(window.location.hash);
  init(root).catch((error) => {
    root.querySelector("[data-uwp-count]").textContent = "Daten derzeit nicht verfügbar";
    const message = root.querySelector("[data-uwp-error]");
    message.textContent = "Die Profile konnten nicht geladen werden. Bitte lade die Seite erneut.";
    message.hidden = false;
    console.error(error);
  });
}
