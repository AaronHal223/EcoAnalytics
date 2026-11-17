// Frost and heat alerts, shared by the page and the service worker.
//
// No server is involved: on phones that allow it (Android Chrome with the app
// added to the home screen), the browser wakes the service worker about twice a
// day, it fetches the free 3-day forecast for the garden, and if a frost or a
// heat wave threatens the crops in the plan it shows a notification. Nothing
// leaves the phone except the forecast request itself (just the coordinates).
//
// Written as a plain script (no import/export) so the service worker can load
// it with importScripts(); the page and the tests read globalThis.EcoAlerts.

(function (root) {
  const FROST_F = 33, HARD_FREEZE_F = 26, HEAT_F = 95;

  const toC = f => Math.round((f - 32) * 5 / 9);
  const temp = (f, metric) => (metric ? `${toC(f)}°C` : `${Math.round(f)}°F`);
  const when = (date, today) => {
    if (date === today) return "tonight";
    const d = new Date(date + "T12:00:00Z");
    return d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }) + " night";
  };
  const list = a => (a.length <= 2 ? a.join(" and ") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

  /**
   * Alerts for the next two days.
   * @param days  [{date, tmin, tmax}] starting today (local dates, °F)
   * @param cfg   {tender: [names], hardy: [names], metric}
   * @param sent  set or array of alert ids already shown (so each alert is shown once)
   * @returns [{id, title, body}]
   */
  function alertsFor(days, cfg, sent) {
    const done = new Set(sent || []);
    const out = [];
    if (!Array.isArray(days) || !days.length || !cfg) return out;
    const today = days[0].date;
    const tender = cfg.tender || [], hardy = cfg.hardy || [];
    for (const d of days.slice(0, 2)) {
      if (d.tmin != null && d.tmin <= HARD_FREEZE_F && (tender.length || hardy.length)) {
        const id = `freeze:${d.date}`;
        if (!done.has(id)) out.push({ id, title: `Hard freeze ${when(d.date, today)} (${temp(d.tmin, cfg.metric)})`,
          body: `Cover ${list([...tender, ...hardy].slice(0, 4))} before dark, or pick what's ready.` });
      } else if (d.tmin != null && d.tmin <= FROST_F && tender.length) {
        const id = `frost:${d.date}`;
        if (!done.has(id)) out.push({ id, title: `Frost ${when(d.date, today)} (${temp(d.tmin, cfg.metric)})`,
          body: `Cover ${list(tender.slice(0, 4))} before dark with sheets or buckets. Uncover in the morning.` });
      }
      if (d.tmax != null && d.tmax >= HEAT_F && (tender.length || hardy.length)) {
        const id = `heat:${d.date}`;
        if (!done.has(id)) out.push({ id, title: `Heat ${d.date === today ? "today" : "tomorrow"} (${temp(d.tmax, cfg.metric)})`,
          body: "Water deeply early in the morning and shade lettuce and spinach in the afternoon." });
      }
    }
    return out;
  }

  /** Open-Meteo request for 3 days of min/max temperature at the garden. */
  function forecastUrl(lat, lon) {
    const q = new URLSearchParams({ latitude: (+lat).toFixed(2), longitude: (+lon).toFixed(2),
      daily: "temperature_2m_max,temperature_2m_min", temperature_unit: "fahrenheit", timezone: "auto", forecast_days: "3" });
    return `https://api.open-meteo.com/v1/forecast?${q}`;
  }

  function parse(json) {
    const d = json && json.daily;
    if (!d || !Array.isArray(d.time)) return [];
    return d.time.map((t, i) => ({ date: t, tmax: d.temperature_2m_max?.[i] ?? null, tmin: d.temperature_2m_min?.[i] ?? null }));
  }

  root.EcoAlerts = { alertsFor, forecastUrl, parse, FROST_F, HARD_FREEZE_F, HEAT_F };
})(typeof self !== "undefined" ? self : globalThis);
