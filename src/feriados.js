import { XMLParser } from "fast-xml-parser";

const CALENDARIO_API_URL = "https://calendario.com.br/api/data.php";
const FERIADOS_SITE_URL = "https://feriados.com.br";

const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "api-calendarios/1.0 (+https://localhost)";

export const HOLIDAY_TYPES = Object.freeze({
  1: { key: "nacional", name: "Nacional" },
  2: { key: "estadual", name: "Estadual" },
  3: { key: "municipal", name: "Municipal" },
  4: { key: "ponto_facultativo", name: "Ponto Facultativo" },
  9: { key: "comemorativo", name: "Comemorativo" },
});

const decodeKeyCache = {
  value: null,
  fetchedAtMs: 0,
  ttlMs: 24 * 60 * 60 * 1000,
};

const holidaysCache = new Map();
const HOLIDAYS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function normalizeCity(city) {
  return city
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[âÂ']/g, "")
    .toUpperCase()
    .trim();
}

function xorBytes(dataBuffer, keyBuffer) {
  const out = Buffer.allocUnsafe(dataBuffer.length);
  for (let i = 0; i < dataBuffer.length; i++) {
    out[i] = dataBuffer[i] ^ keyBuffer[i % keyBuffer.length];
  }
  return out;
}

function decodeCalendarioPayload(base64Payload, keyBytes) {
  const data = Buffer.from(String(base64Payload).trim(), "base64");
  const decodedBytes = xorBytes(data, keyBytes);
  return new TextDecoder("utf-8").decode(decodedBytes);
}

async function fetchTextWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/plain, text/html;q=0.9, */*;q=0.8",
        "user-agent": USER_AGENT,
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ao buscar ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getDecodeKeyBytes() {
  const now = Date.now();
  if (decodeKeyCache.value && now - decodeKeyCache.fetchedAtMs < decodeKeyCache.ttlMs) {
    return decodeKeyCache.value;
  }

  const html = await fetchTextWithTimeout(`${FERIADOS_SITE_URL}/`);

  const arrayDeclMatch = html.match(
    /var\s+(_\$_[0-9a-fA-F]+)=\[(?<arr>[\s\S]*?)\];const\s+__a=\1\[0\];/
  );
  if (!arrayDeclMatch?.groups?.arr) {
    throw new Error("Não foi possível localizar a chave de decodificação no HTML do feriados.com.br");
  }

  const firstStringMatch = arrayDeclMatch.groups.arr.match(/^\s*"(?<s>(?:\\.|[^"\\])*)"/);
  if (!firstStringMatch?.groups?.s) {
    throw new Error("Não foi possível extrair a string de chave de decodificação no HTML do feriados.com.br");
  }

  const bytes = [];
  const raw = firstStringMatch.groups.s;
  const rx = /\\x([0-9a-fA-F]{2})/g;
  let m;
  while ((m = rx.exec(raw)) !== null) {
    bytes.push(Number.parseInt(m[1], 16));
  }
  if (bytes.length === 0) {
    throw new Error("Chave de decodificação inesperada (nenhum byte encontrado)");
  }
  const keyBytes = Buffer.from(bytes);

  decodeKeyCache.value = keyBytes;
  decodeKeyCache.fetchedAtMs = now;

  return keyBytes;
}

function normalizeEventsXml(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: true,
    trimValues: true,
    parseTagValue: true,
  });
  const parsed = parser.parse(xmlText);

  const eventsCandidate =
    parsed?.data?.event ??
    parsed?.events?.event ??
    parsed?.event ??
    parsed?.data?.events ??
    parsed?.events ??
    [];

  const events = Array.isArray(eventsCandidate) ? eventsCandidate : [eventsCandidate].filter(Boolean);

  return events
    .map((ev) => {
      const dateRaw = ev?.date;
      const name = ev?.name;
      const typeCodeRaw = ev?.type_code;
      const description = ev?.description;
      const link = ev?.link;

      if (!dateRaw || !name || !typeCodeRaw) return null;

      const [dd, mm, yyyy] = String(dateRaw).split("/");
      if (!dd || !mm || !yyyy) return null;

      const date = `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      const codetype = Number.parseInt(String(typeCodeRaw), 10);

      return {
        date,
        name: String(name).trim(),
        codetype,
        description: description ? String(description).trim() : String(name).trim(),
        link: link ? String(link).trim() : null,
      };
    })
    .filter(Boolean);
}

export async function listarFeriados({ ano, uf, cidade } = {}) {
  const year = Number.parseInt(String(ano ?? ""), 10);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw new Error("Parâmetro 'ano' inválido (use um ano entre 1900 e 2100)");
  }

  const state = uf ? String(uf).trim().toUpperCase() : null;
  if (state && !/^[A-Z]{2}$/.test(state)) {
    throw new Error("Parâmetro 'uf' inválido (use 2 letras, ex: SP)");
  }

  const city = cidade ? String(cidade).trim() : null;

  const cacheKey = `${year}|${state ?? ""}|${city ?? ""}`;
  const cached = holidaysCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAtMs) {
    return cached.data;
  }

  const qs = new URLSearchParams({ ano: String(year) });
  if (state) qs.set("estado", state);
  if (city) qs.set("cidade", normalizeCity(city));

  const url = `${CALENDARIO_API_URL}?${qs.toString()}`;
  const base64Payload = await fetchTextWithTimeout(url);
  const keyBytes = await getDecodeKeyBytes();
  const xmlText = decodeCalendarioPayload(base64Payload, keyBytes);
  const rawEvents = normalizeEventsXml(xmlText);

  const items = rawEvents.map((ev) => {
    const typeInfo = HOLIDAY_TYPES[ev.codetype] ?? { key: "desconhecido", name: "Desconhecido" };
    return {
      data: ev.date,
      nome: ev.name,
      tipo: typeInfo.name,
      tipoKey: typeInfo.key,
      codigoTipo: ev.codetype,
      descricao: ev.description,
      link: ev.link,
      uf: state,
      cidade: city,
    };
  });

  const byType = Object.create(null);
  for (const item of items) {
    if (!byType[item.tipoKey]) byType[item.tipoKey] = [];
    byType[item.tipoKey].push(item);
  }

  const payload = {
    fonte: {
      site: FERIADOS_SITE_URL,
      calendarioApi: CALENDARIO_API_URL,
      ano: year,
      uf: state,
      cidade: city,
    },
    items,
    porTipo: byType,
  };

  holidaysCache.set(cacheKey, { data: payload, expiresAtMs: Date.now() + HOLIDAYS_CACHE_TTL_MS });
  return payload;
}
