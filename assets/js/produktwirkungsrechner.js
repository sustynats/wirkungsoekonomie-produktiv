(function () {
  const root = document.querySelector("[data-product-impact-calculator]");
  if (!root) return;

  const presets = {
    bioApfel: {
      name: "Bio-Apfel regional",
      price: 1,
      scores: { mensch: 2, planet: 1, demokratie: 1, daten: 2 },
      explanation: "Regionale und geprüfte Daten können den Prüfpfad stärken; ein Score begründet jedoch keine automatische Tarifentscheidung.",
    },
    chileApfel: {
      name: "Chile-Apfel importiert",
      price: 1,
      scores: { mensch: 0, planet: -1, demokratie: 0, daten: 1 },
      explanation: "Transport, Wasserstress und Datenlage können den Prüfstatus begrenzen. Das Beispiel ist bewusst modellhaft.",
    },
    tshirt: {
      name: "T-Shirt",
      price: 24,
      scores: { mensch: null, planet: -1, demokratie: null, daten: null },
      explanation: "Textilien hängen stark an Arbeit, Wasser, Chemie, Nutzungsdauer und Kreislauffähigkeit; der Prüfstatus ist keine Preisvorgabe.",
    },
    polyamid: {
      name: "Polyamid Produktgruppe",
      price: 399,
      scores: { mensch: 0, planet: -2, demokratie: 0, daten: 1 },
      explanation: "Das Polyamid-Beispiel zeigt den Weg von Konzern- und ESRS-Daten zu Produktgruppen, nicht eine amtliche Einstufung oder Tarifentscheidung.",
    },
  };

  const form = root.querySelector("form");
  const productSelect = form.elements.product;
  const fields = ["mensch", "planet", "demokratie", "daten"];
  const result = (key) => root.querySelector(`[data-result="${key}"]`);
  const productName = root.querySelector("#calc-product-name");
  const money = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });

  function numericInput(input) {
    if (input.value.trim() === "" || !input.validity.valid) return null;
    const number = Number(input.value);
    return Number.isFinite(number) ? number : null;
  }

  function formatScore(score) {
    return score > 0 ? `+${score}` : String(score);
  }

  function render() {
    const scores = fields.slice(0, 3).map((field) => numericInput(form.elements[field]));
    const dataQuality = numericInput(form.elements.daten);
    const boundary = form.elements.hardBoundary.value;
    const score = scores.includes(null) ? null : Math.min(...scores);
    const net = numericInput(form.elements.netPrice);
    const rate = numericInput(form.elements.modelRate);
    const netCents = net === null ? null : Math.round(net * 100);
    const grossCents = netCents === null || rate === null
      ? null : netCents + Math.floor((netCents * Math.round(rate * 10) + 500) / 1000);
    const selected = presets[productSelect.value] || presets.bioApfel;

    productName.textContent = selected.name;
    result("finalScore").textContent = score === null ? "OFFEN" : formatScore(score);
    result("status").textContent = boundary === "VIOLATED"
      ? "BLOCKIERT: Eine angenommene schwere Schutzverletzung bleibt bei jedem Engpasssignal bestehen."
      : score === null || dataQuality === null || dataQuality < 0 || boundary === "OFFEN"
        ? "OFFEN: Schutzstatus, Kernfelder und Datenqualität müssen ausreichend belegt sein."
        : "Modellprofil vollständig eingegeben. Eine fachliche Produktklassifizierung erfordert anwendbare Regeln und belegte Daten.";
    result("modelRate").textContent = rate === null ? "OFFEN" : `${rate.toLocaleString("de-DE")} % (Testannahme)`;
    result("netPrice").textContent = netCents === null ? "OFFEN" : money.format(netCents / 100);
    result("grossPrice").textContent = grossCents === null ? "OFFEN" : money.format(grossCents / 100);
    result("explanation").textContent = selected.explanation;
  }

  productSelect.addEventListener("change", () => {
    const selected = presets[productSelect.value] || presets.bioApfel;
    form.elements.netPrice.value = selected.price.toFixed(2);
    fields.forEach((field) => {
      form.elements[field].value = selected.scores[field] ?? "";
    });
    form.elements.hardBoundary.value = "OFFEN";
    render();
  });

  form.addEventListener("input", render);
  form.addEventListener("submit", (event) => event.preventDefault());
  productSelect.dispatchEvent(new Event("change"));
})();
