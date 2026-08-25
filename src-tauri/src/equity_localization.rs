use super::*;

const EQUITY_LOCALIZATION_CACHE_VERSION: u32 = 1;
const EQUITY_LOCALIZATION_MATCH_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
const EQUITY_LOCALIZATION_MISS_TTL_MS: i64 = 24 * 60 * 60 * 1_000;
const EQUITY_LOCALIZATION_MAX_BYTES: usize = 2 * 1_024 * 1_024;
const EQUITY_LOCALIZATION_SOURCE: &str = "Wikidata";
const WIKIDATA_SPARQL_URL: &str = "https://query.wikidata.org/sparql";
const DESIC_HTTP_USER_AGENT: &str = concat!(
    "DesicTerminal/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/xiazhi88/Desic-Terminal)"
);

static EQUITY_LOCALIZATION_REFRESH_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EquityLocalizationRequest {
    ticker: String,
    exchange: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EquityLocalizationRecord {
    ticker: String,
    exchange: String,
    entity_id: Option<String>,
    name_zh_hans: Option<String>,
    name_zh_hant: Option<String>,
    updated_at: i64,
}

impl EquityLocalizationRecord {
    fn has_name(&self) -> bool {
        self.name_zh_hans.is_some() || self.name_zh_hant.is_some()
    }

    fn key(&self) -> String {
        localization_key(&self.ticker, &self.exchange)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EquityLocalizationCache {
    cache_version: u32,
    source: String,
    records: Vec<EquityLocalizationRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EquitySecurityLocalization {
    ticker: String,
    exchange: String,
    name_zh_hans: Option<String>,
    name_zh_hant: Option<String>,
    updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EquitySecurityLocalizations {
    source: String,
    localizations: Vec<EquitySecurityLocalization>,
}

#[derive(Clone, Debug, Default)]
struct WikidataCandidate {
    entity_id: String,
    name_zh_hans: Option<String>,
    name_zh_hant: Option<String>,
}

#[tauri::command]
pub async fn equity_security_localizations(
    app: tauri::AppHandle,
    securities: Vec<EquityLocalizationRequest>,
) -> Result<EquitySecurityLocalizations, String> {
    if securities.len() > 1_000 {
        return Err("Equity localization is limited to 1,000 securities".to_string());
    }
    let requested = securities
        .into_iter()
        .filter_map(normalize_localization_request)
        .map(|request| {
            (
                localization_key(&request.ticker, &request.exchange),
                request,
            )
        })
        .collect::<BTreeMap<_, _>>();
    if requested.is_empty() {
        return Ok(EquitySecurityLocalizations {
            source: EQUITY_LOCALIZATION_SOURCE.to_string(),
            localizations: Vec::new(),
        });
    }

    let lock = EQUITY_LOCALIZATION_REFRESH_LOCK.get_or_init(|| AsyncMutex::new(()));
    let _guard = lock.lock().await;
    let cache_path = market_assets_cache_dir(&app)?.join("equity-localizations.json");
    let mut cached = load_localization_cache(&cache_path)
        .filter(|cache| cache.cache_version == EQUITY_LOCALIZATION_CACHE_VERSION)
        .unwrap_or_else(empty_localization_cache)
        .records
        .into_iter()
        .map(|record| (record.key(), record))
        .collect::<BTreeMap<_, _>>();
    let now = now_ms();
    let stale = requested
        .iter()
        .filter_map(|(key, request)| {
            let record = cached.get(key);
            let ttl = if record.is_some_and(EquityLocalizationRecord::has_name) {
                EQUITY_LOCALIZATION_MATCH_TTL_MS
            } else {
                EQUITY_LOCALIZATION_MISS_TTL_MS
            };
            let is_stale =
                record.map_or(true, |record| now.saturating_sub(record.updated_at) >= ttl);
            is_stale.then_some(request.clone())
        })
        .collect::<Vec<_>>();

    if !stale.is_empty() {
        match fetch_wikidata_localizations(&stale).await {
            Ok(refreshed) => {
                for record in refreshed {
                    cached.insert(record.key(), record);
                }
                cached.retain(|_, record| {
                    now.saturating_sub(record.updated_at) < 90 * 24 * 60 * 60 * 1_000
                        || requested.contains_key(&record.key())
                });
                let cache = EquityLocalizationCache {
                    cache_version: EQUITY_LOCALIZATION_CACHE_VERSION,
                    source: EQUITY_LOCALIZATION_SOURCE.to_string(),
                    records: cached.values().cloned().collect(),
                };
                persist_localization_cache(&cache_path, &cache)?;
            }
            Err(error) => {
                eprintln!("equity localization refresh failed, using cached names: {error}");
            }
        }
    }

    Ok(EquitySecurityLocalizations {
        source: EQUITY_LOCALIZATION_SOURCE.to_string(),
        localizations: requested
            .keys()
            .filter_map(|key| cached.get(key))
            .filter(|record| record.has_name())
            .map(|record| EquitySecurityLocalization {
                ticker: record.ticker.clone(),
                exchange: record.exchange.clone(),
                name_zh_hans: record.name_zh_hans.clone(),
                name_zh_hant: record.name_zh_hant.clone(),
                updated_at: record.updated_at,
            })
            .collect(),
    })
}

fn normalize_localization_request(
    request: EquityLocalizationRequest,
) -> Option<EquityLocalizationRequest> {
    let ticker = normalize_ticker(&request.ticker)?;
    exchange_qid(&request.exchange)?;
    Some(EquityLocalizationRequest {
        ticker,
        exchange: request.exchange,
    })
}

async fn fetch_wikidata_localizations(
    requested: &[EquityLocalizationRequest],
) -> Result<Vec<EquityLocalizationRecord>, String> {
    let query = wikidata_query(requested);
    let response = reqwest_client()?
        .post(WIKIDATA_SPARQL_URL)
        .header(reqwest::header::USER_AGENT, DESIC_HTTP_USER_AGENT)
        .header(reqwest::header::ACCEPT, "application/sparql-results+json")
        .header(reqwest::header::CONTENT_TYPE, "application/sparql-query")
        .timeout(Duration::from_secs(15))
        .body(query)
        .send()
        .await
        .map_err(|error| format!("Wikidata localization request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Wikidata localization returned HTTP {status}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Wikidata localization body failed: {error}"))?;
    if bytes.len() > EQUITY_LOCALIZATION_MAX_BYTES {
        return Err("Wikidata localization payload exceeds 2 MiB".to_string());
    }
    let payload: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Wikidata localization JSON is invalid: {error}"))?;
    Ok(parse_wikidata_localizations(requested, &payload, now_ms()))
}

fn wikidata_query(requested: &[EquityLocalizationRequest]) -> String {
    let values = requested
        .iter()
        .filter_map(|request| {
            let exchange = exchange_qid(&request.exchange)?;
            Some(format!("(\"{}\" wd:{exchange})", request.ticker))
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "SELECT ?ticker ?exchange ?item ?zh ?zhHans ?zhHant WHERE {{\n\
         VALUES (?ticker ?exchange) {{ {values} }}\n\
         ?item p:P414 ?listing .\n\
         ?listing pq:P249 ?ticker ; ps:P414 ?exchange .\n\
         OPTIONAL {{ ?item rdfs:label ?zh . FILTER(LANG(?zh) = \"zh\") }}\n\
         OPTIONAL {{ ?item rdfs:label ?zhHans . FILTER(LANG(?zhHans) = \"zh-hans\") }}\n\
         OPTIONAL {{ ?item rdfs:label ?zhHant . FILTER(LANG(?zhHant) = \"zh-hant\") }}\n\
         }}"
    )
}

fn parse_wikidata_localizations(
    requested: &[EquityLocalizationRequest],
    payload: &Value,
    updated_at: i64,
) -> Vec<EquityLocalizationRecord> {
    let mut candidates = BTreeMap::<String, BTreeMap<String, WikidataCandidate>>::new();
    let bindings = payload
        .get("results")
        .and_then(|results| results.get("bindings"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for binding in bindings {
        let Some(ticker) = binding_value(binding, "ticker").and_then(normalize_ticker) else {
            continue;
        };
        let Some(exchange_id) = binding_value(binding, "exchange")
            .and_then(|value| value.rsplit('/').next())
            .filter(|value| valid_entity_id(value))
        else {
            continue;
        };
        let Some(entity_id) = binding_value(binding, "item")
            .and_then(|value| value.rsplit('/').next())
            .filter(|value| valid_entity_id(value))
            .map(str::to_string)
        else {
            continue;
        };
        let candidate = candidates
            .entry(format!("{ticker}|{exchange_id}"))
            .or_default()
            .entry(entity_id.clone())
            .or_insert_with(|| WikidataCandidate {
                entity_id,
                ..WikidataCandidate::default()
            });
        let generic = binding_value(binding, "zh").and_then(normalize_localized_name);
        candidate.name_zh_hans = candidate.name_zh_hans.clone().or_else(|| {
            binding_value(binding, "zhHans")
                .and_then(normalize_localized_name)
                .or_else(|| generic.clone())
        });
        candidate.name_zh_hant = candidate.name_zh_hant.clone().or_else(|| {
            binding_value(binding, "zhHant")
                .and_then(normalize_localized_name)
                .or(generic)
        });
    }

    requested
        .iter()
        .map(|request| {
            let candidate_key = exchange_qid(&request.exchange)
                .map(|exchange_id| format!("{}|{exchange_id}", request.ticker));
            let unique = candidate_key
                .as_ref()
                .and_then(|key| candidates.get(key))
                .and_then(|items| (items.len() == 1).then(|| items.values().next()))
                .flatten();
            EquityLocalizationRecord {
                ticker: request.ticker.clone(),
                exchange: request.exchange.clone(),
                entity_id: unique.map(|candidate| candidate.entity_id.clone()),
                name_zh_hans: unique.and_then(|candidate| candidate.name_zh_hans.clone()),
                name_zh_hant: unique.and_then(|candidate| candidate.name_zh_hant.clone()),
                updated_at,
            }
        })
        .collect()
}

fn binding_value<'a>(binding: &'a Value, key: &str) -> Option<&'a str> {
    binding
        .get(key)
        .and_then(|value| value.get("value"))
        .and_then(Value::as_str)
}

fn normalize_ticker(value: &str) -> Option<String> {
    let ticker = value.trim().to_ascii_uppercase().replace('.', "-");
    if ticker.is_empty()
        || ticker.len() > 24
        || !ticker
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return None;
    }
    Some(ticker)
}

fn normalize_localized_name(value: &str) -> Option<String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) {
        return None;
    }
    Some(name.to_string())
}

fn valid_entity_id(value: &str) -> bool {
    value.len() >= 2
        && value.len() <= 24
        && value.starts_with('Q')
        && value[1..].bytes().all(|byte| byte.is_ascii_digit())
}

fn exchange_qid(exchange: &str) -> Option<&'static str> {
    match exchange {
        "NASDAQ" => Some("Q82059"),
        "NYSE" => Some("Q13677"),
        "NYSE Arca" => Some("Q10593835"),
        "NYSE American" => Some("Q846626"),
        "IEX" => Some("Q16846407"),
        "Cboe BZX" => Some("Q107188457"),
        _ => None,
    }
}

fn localization_key(ticker: &str, exchange: &str) -> String {
    format!("{ticker}|{exchange}")
}

fn empty_localization_cache() -> EquityLocalizationCache {
    EquityLocalizationCache {
        cache_version: EQUITY_LOCALIZATION_CACHE_VERSION,
        source: EQUITY_LOCALIZATION_SOURCE.to_string(),
        records: Vec::new(),
    }
}

fn load_localization_cache(path: &Path) -> Option<EquityLocalizationCache> {
    if fs::metadata(path).ok()?.len() > EQUITY_LOCALIZATION_MAX_BYTES as u64 {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn persist_localization_cache(path: &Path, cache: &EquityLocalizationCache) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec(cache).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(ticker: &str, exchange: &str) -> EquityLocalizationRequest {
        EquityLocalizationRequest {
            ticker: ticker.to_string(),
            exchange: exchange.to_string(),
        }
    }

    #[test]
    fn query_binds_ticker_to_the_official_listing_exchange() {
        let query = wikidata_query(&[request("AAPL", "NASDAQ"), request("SPY", "NYSE Arca")]);
        assert!(query.contains("(\"AAPL\" wd:Q82059)"));
        assert!(query.contains("(\"SPY\" wd:Q10593835)"));
        assert!(query.contains("pq:P249 ?ticker ; ps:P414 ?exchange"));
    }

    #[test]
    fn parses_language_variants_and_marks_missing_tickers() {
        let payload = json!({
            "results": { "bindings": [
                {
                    "ticker": { "value": "AAPL" },
                    "exchange": { "value": "http://www.wikidata.org/entity/Q82059" },
                    "item": { "value": "http://www.wikidata.org/entity/Q312" },
                    "zh": { "value": "蘋果公司" },
                    "zhHans": { "value": "苹果公司" },
                    "zhHant": { "value": "蘋果公司" }
                }
            ] }
        });
        let rows = parse_wikidata_localizations(
            &[request("AAPL", "NASDAQ"), request("NEW", "NASDAQ")],
            &payload,
            42,
        );
        assert_eq!(rows[0].name_zh_hans.as_deref(), Some("苹果公司"));
        assert_eq!(rows[0].name_zh_hant.as_deref(), Some("蘋果公司"));
        assert_eq!(rows[0].entity_id.as_deref(), Some("Q312"));
        assert!(!rows[1].has_name());
        assert_eq!(rows[1].updated_at, 42);
    }

    #[test]
    fn ambiguous_same_exchange_entities_fail_closed() {
        let payload = json!({
            "results": { "bindings": [
                { "ticker": { "value": "SAME" }, "exchange": { "value": "http://www.wikidata.org/entity/Q82059" }, "item": { "value": "http://www.wikidata.org/entity/Q1" }, "zhHans": { "value": "甲" } },
                { "ticker": { "value": "SAME" }, "exchange": { "value": "http://www.wikidata.org/entity/Q82059" }, "item": { "value": "http://www.wikidata.org/entity/Q2" }, "zhHans": { "value": "乙" } }
            ] }
        });
        let rows = parse_wikidata_localizations(&[request("SAME", "NASDAQ")], &payload, 7);
        assert!(!rows[0].has_name());
        assert!(rows[0].entity_id.is_none());
    }

    #[test]
    fn same_ticker_on_another_exchange_does_not_contaminate_the_match() {
        let payload = json!({
            "results": { "bindings": [
                { "ticker": { "value": "SAME" }, "exchange": { "value": "http://www.wikidata.org/entity/Q82059" }, "item": { "value": "http://www.wikidata.org/entity/Q1" }, "zhHans": { "value": "纳斯达克实体" } },
                { "ticker": { "value": "SAME" }, "exchange": { "value": "http://www.wikidata.org/entity/Q13677" }, "item": { "value": "http://www.wikidata.org/entity/Q2" }, "zhHans": { "value": "纽交所实体" } }
            ] }
        });
        let rows = parse_wikidata_localizations(&[request("SAME", "NASDAQ")], &payload, 7);
        assert_eq!(rows[0].name_zh_hans.as_deref(), Some("纳斯达克实体"));
        assert_eq!(rows[0].entity_id.as_deref(), Some("Q1"));
    }

    #[test]
    fn unsupported_exchanges_and_unsafe_tickers_are_rejected() {
        assert!(normalize_localization_request(request("AAPL", "NASDAQ")).is_some());
        assert!(normalize_localization_request(request("AAPL/../", "NASDAQ")).is_none());
        assert!(normalize_localization_request(request("AAPL", "Unknown")).is_none());
    }
}
