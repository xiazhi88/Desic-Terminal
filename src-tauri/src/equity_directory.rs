use super::*;

const EQUITY_DIRECTORY_CACHE_VERSION: u32 = 1;
const EQUITY_DIRECTORY_TTL_MS: i64 = 24 * 60 * 60 * 1_000;
const EQUITY_DIRECTORY_MAX_BYTES: usize = 2 * 1_024 * 1_024;
const NASDAQ_LISTED_URL: &str = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt";
const OTHER_LISTED_URL: &str = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt";
const EQUITY_DIRECTORY_SOURCE: &str = "NASDAQ Trader Symbol Directory";

static EQUITY_DIRECTORY_REFRESH_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EquitySecurityRecord {
    ticker: String,
    security_name: String,
    exchange: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EquityDirectoryCache {
    cache_version: u32,
    source: String,
    updated_at: i64,
    securities: Vec<EquitySecurityRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EquitySecurityDirectory {
    source: String,
    updated_at: i64,
    stale: bool,
    securities: Vec<EquitySecurityRecord>,
}

#[tauri::command]
pub async fn equity_security_directory(
    app: tauri::AppHandle,
    tickers: Vec<String>,
) -> Result<EquitySecurityDirectory, String> {
    if tickers.len() > 1_000 {
        return Err("Equity security lookup is limited to 1,000 tickers".to_string());
    }
    let requested = tickers
        .into_iter()
        .filter_map(|ticker| normalize_equity_ticker(&ticker))
        .collect::<HashSet<_>>();
    if requested.is_empty() {
        return Ok(EquitySecurityDirectory {
            source: EQUITY_DIRECTORY_SOURCE.to_string(),
            updated_at: 0,
            stale: false,
            securities: Vec::new(),
        });
    }

    let lock = EQUITY_DIRECTORY_REFRESH_LOCK.get_or_init(|| AsyncMutex::new(()));
    let _guard = lock.lock().await;
    let cache_path = market_assets_cache_dir(&app)?.join("equity-securities.json");
    let cached = load_equity_directory_cache(&cache_path)
        .filter(|cache| cache.cache_version == EQUITY_DIRECTORY_CACHE_VERSION);
    let now = now_ms();
    if let Some(cache) = cached
        .as_ref()
        .filter(|cache| now.saturating_sub(cache.updated_at) < EQUITY_DIRECTORY_TTL_MS)
    {
        return Ok(filter_equity_directory(cache, &requested, false));
    }

    match refresh_equity_directory().await {
        Ok(cache) => {
            persist_equity_directory_cache(&cache_path, &cache)?;
            Ok(filter_equity_directory(&cache, &requested, false))
        }
        Err(error) => {
            if let Some(cache) = cached {
                eprintln!("equity directory refresh failed, using stale cache: {error}");
                Ok(filter_equity_directory(&cache, &requested, true))
            } else {
                Err(error)
            }
        }
    }
}

fn filter_equity_directory(
    cache: &EquityDirectoryCache,
    requested: &HashSet<String>,
    stale: bool,
) -> EquitySecurityDirectory {
    EquitySecurityDirectory {
        source: cache.source.clone(),
        updated_at: cache.updated_at,
        stale,
        securities: cache
            .securities
            .iter()
            .filter(|security| requested.contains(&security.ticker))
            .cloned()
            .collect(),
    }
}

async fn refresh_equity_directory() -> Result<EquityDirectoryCache, String> {
    let client = reqwest_client()?;
    let (nasdaq, other) = tokio::join!(
        fetch_equity_directory_text(&client, NASDAQ_LISTED_URL),
        fetch_equity_directory_text(&client, OTHER_LISTED_URL),
    );

    let mut securities = BTreeMap::<String, EquitySecurityRecord>::new();
    let mut errors = Vec::new();
    match nasdaq {
        Ok(text) => {
            for security in parse_symbol_directory(&text, "Symbol", None)? {
                securities.insert(security.ticker.clone(), security);
            }
        }
        Err(error) => errors.push(error),
    }
    match other {
        Ok(text) => {
            for security in parse_symbol_directory(&text, "ACT Symbol", Some("Exchange"))? {
                securities.insert(security.ticker.clone(), security);
            }
        }
        Err(error) => errors.push(error),
    }

    if securities.is_empty() {
        return Err(format!(
            "Equity security directories are unavailable: {}",
            errors.join("; ")
        ));
    }
    if !errors.is_empty() {
        return Err(format!(
            "Equity security directory refresh was incomplete: {}",
            errors.join("; ")
        ));
    }

    Ok(EquityDirectoryCache {
        cache_version: EQUITY_DIRECTORY_CACHE_VERSION,
        source: EQUITY_DIRECTORY_SOURCE.to_string(),
        updated_at: now_ms(),
        securities: securities.into_values().collect(),
    })
}

async fn fetch_equity_directory_text(
    client: &reqwest::Client,
    url: &str,
) -> Result<String, String> {
    let response = client
        .get(url)
        .header(
            reqwest::header::USER_AGENT,
            "DesicTerminal/0.1.33 (+https://github.com/xiazhi88/Desic-Terminal)",
        )
        .send()
        .await
        .map_err(|error| format!("{url}: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url}: HTTP {status}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("{url}: {error}"))?;
    if bytes.len() > EQUITY_DIRECTORY_MAX_BYTES {
        return Err(format!("{url}: payload exceeds 2 MiB"));
    }
    String::from_utf8(bytes.to_vec()).map_err(|error| format!("{url}: {error}"))
}

fn parse_symbol_directory(
    content: &str,
    symbol_header: &str,
    exchange_header: Option<&str>,
) -> Result<Vec<EquitySecurityRecord>, String> {
    let mut lines = content.lines();
    let header = lines
        .next()
        .ok_or_else(|| "Equity symbol directory is empty".to_string())?
        .trim_end_matches('\r')
        .split('|')
        .collect::<Vec<_>>();
    let symbol_index = header
        .iter()
        .position(|field| *field == symbol_header)
        .ok_or_else(|| format!("Equity symbol directory is missing {symbol_header}"))?;
    let name_index = header
        .iter()
        .position(|field| *field == "Security Name")
        .ok_or_else(|| "Equity symbol directory is missing Security Name".to_string())?;
    let exchange_index =
        exchange_header.and_then(|field| header.iter().position(|item| *item == field));

    let mut records = Vec::new();
    for line in lines {
        let fields = line.trim_end_matches('\r').split('|').collect::<Vec<_>>();
        let Some(ticker) = fields
            .get(symbol_index)
            .and_then(|value| normalize_equity_ticker(value))
        else {
            continue;
        };
        let security_name = fields.get(name_index).map_or("", |value| value.trim());
        if security_name.is_empty()
            || security_name.chars().count() > 240
            || security_name.chars().any(char::is_control)
        {
            continue;
        }
        let exchange = exchange_index
            .and_then(|index| fields.get(index))
            .map_or("NASDAQ", |value| equity_exchange_name(value.trim()))
            .to_string();
        records.push(EquitySecurityRecord {
            ticker,
            security_name: security_name.to_string(),
            exchange,
        });
    }
    Ok(records)
}

fn normalize_equity_ticker(value: &str) -> Option<String> {
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

fn equity_exchange_name(code: &str) -> &'static str {
    match code {
        "A" => "NYSE American",
        "N" => "NYSE",
        "P" => "NYSE Arca",
        "V" => "IEX",
        "Z" => "Cboe BZX",
        _ => "Other",
    }
}

fn load_equity_directory_cache(path: &Path) -> Option<EquityDirectoryCache> {
    if fs::metadata(path).ok()?.len() > (EQUITY_DIRECTORY_MAX_BYTES * 2) as u64 {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn persist_equity_directory_cache(path: &Path, cache: &EquityDirectoryCache) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec(cache).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nasdaq_and_other_listed_directories() {
        let nasdaq = "Symbol|Security Name|Market Category|Test Issue\r\nAAPL|Apple Inc. - Common Stock|Q|N\r\nFile Creation Time: 08252026||||\r\n";
        let other = "ACT Symbol|Security Name|Exchange|CQS Symbol\r\nBRK.A|Berkshire Hathaway Inc. Class A|N|BRK.A\r\nSPY|SPDR S&P 500 ETF Trust Units|P|SPY\r\n";
        let nasdaq_rows = parse_symbol_directory(nasdaq, "Symbol", None).unwrap();
        let other_rows = parse_symbol_directory(other, "ACT Symbol", Some("Exchange")).unwrap();

        assert_eq!(nasdaq_rows.len(), 1);
        assert_eq!(nasdaq_rows[0].ticker, "AAPL");
        assert_eq!(nasdaq_rows[0].exchange, "NASDAQ");
        assert_eq!(other_rows[0].ticker, "BRK-A");
        assert_eq!(other_rows[0].exchange, "NYSE");
        assert_eq!(other_rows[1].exchange, "NYSE Arca");
    }

    #[test]
    fn rejects_footer_and_unsafe_ticker_values() {
        assert_eq!(
            normalize_equity_ticker("File Creation Time: 08252026"),
            None
        );
        assert_eq!(normalize_equity_ticker("AAPL/../../cache"), None);
        assert_eq!(
            normalize_equity_ticker(" brk.b "),
            Some("BRK-B".to_string())
        );
    }

    #[test]
    fn rejects_unbounded_security_names() {
        let directory = format!(
            "Symbol|Security Name|Market Category|Test Issue\nLONG|{}|Q|N\n",
            "X".repeat(241)
        );
        let rows = parse_symbol_directory(&directory, "Symbol", None).unwrap();
        assert!(rows.is_empty());
    }
}
