// Local currency.
//
// Every price in the models is in US dollars (US store prices, seed and
// fertilizer costs). For the rest of the world we show money in the local
// currency at today's exchange rate (European Central Bank rates via the free
// Frankfurter service, cached for a day; built-in approximate rates if it can't
// be reached). Amounts people type (water rate, setup cost, their own store
// prices) are in their currency and converted back to dollars for the models.
// Store prices differ by country, so the "Prices where you live" card lets
// people enter their own.

import { getJSON } from "./net.js";

/** Symbol, approximate units per US dollar (fallback only), decimals. */
export const CURRENCIES = {
  USD: { sym: "$", rate: 1, name: "US dollar" },
  EUR: { sym: "€", rate: 0.92, name: "Euro" },
  GBP: { sym: "£", rate: 0.78, name: "British pound" },
  CAD: { sym: "C$", rate: 1.37, name: "Canadian dollar" },
  AUD: { sym: "A$", rate: 1.52, name: "Australian dollar" },
  NZD: { sym: "NZ$", rate: 1.67, name: "New Zealand dollar" },
  INR: { sym: "₹", rate: 84, name: "Indian rupee", dec: 0 },
  MXN: { sym: "MX$", rate: 18.5, name: "Mexican peso" },
  BRL: { sym: "R$", rate: 5.4, name: "Brazilian real" },
  ZAR: { sym: "R ", rate: 18, name: "South African rand" },
  JPY: { sym: "¥", rate: 150, name: "Japanese yen", dec: 0 },
  CHF: { sym: "CHF ", rate: 0.88, name: "Swiss franc" },
  SEK: { sym: "kr ", rate: 10.5, name: "Swedish krona" },
  NOK: { sym: "kr ", rate: 10.8, name: "Norwegian krone" },
  DKK: { sym: "kr ", rate: 6.9, name: "Danish krone" },
  PLN: { sym: "zł ", rate: 4.0, name: "Polish złoty" },
  SGD: { sym: "S$", rate: 1.33, name: "Singapore dollar" },
  PHP: { sym: "₱", rate: 57, name: "Philippine peso" },
  NGN: { sym: "₦", rate: 1550, name: "Nigerian naira", dec: 0 },
  KES: { sym: "KSh ", rate: 130, name: "Kenyan shilling", dec: 0 },
};

const EURO = ["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"];
const BY_REGION = { US: "USD", GB: "GBP", CA: "CAD", AU: "AUD", NZ: "NZD", IN: "INR", MX: "MXN", BR: "BRL", ZA: "ZAR", JP: "JPY", CH: "CHF",
  SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", SG: "SGD", PH: "PHP", NG: "NGN", KE: "KES", ...Object.fromEntries(EURO.map(r => [r, "EUR"])) };

export function defaultCurrency(lang = (typeof navigator !== "undefined" && navigator.language) || "en-US") {
  const region = (String(lang).split(/[-_]/)[1] || "").toUpperCase();
  return BY_REGION[region] || "USD";
}

let code = "USD", rate = 1, live = false;
export const currency = () => ({ ...CURRENCIES[code], code, rate, live });
export function setCurrency(c, r = null) {
  code = CURRENCIES[c] ? c : "USD";
  rate = code === "USD" ? 1 : (Number.isFinite(r) && r > 0 ? r : CURRENCIES[code].rate);
  live = code === "USD" || (Number.isFinite(r) && r > 0);
}
export const toLocal = usd => usd * rate;
export const toUSD = local => local / rate;

/** Money in the chosen currency from a US-dollar amount. */
export function money(usd, d = 2) {
  if (usd == null || !Number.isFinite(+usd)) return "—";
  const c = CURRENCIES[code], v = +usd * rate, dec = c.dec ?? d;
  const digits = Math.min(dec, d);
  return (v < 0 ? "−" : "") + c.sym + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Today's rate (units per US dollar) from the ECB via Frankfurter, or null. */
export async function fetchRate(c) {
  if (c === "USD") return 1;
  const d = await getJSON("https://api.frankfurter.app/latest", { from: "USD", to: c });
  const r = d?.rates?.[c];
  return Number.isFinite(r) && r > 0 ? r : null;
}

/** Regex source matching any currency symbol money() can print (for the metric converter). */
export const SYMBOL_RE = [...new Set(Object.values(CURRENCIES).map(c => c.sym))]
  .sort((a, b) => b.length - a.length).map(s => s.replace(/[$^*+?.()|[\]{}\\]/g, "\\$&")).join("|");
