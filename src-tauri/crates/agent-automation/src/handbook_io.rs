//! 交易手册的导出 / 导入文件。导出只含手册正文（方向纪律、形态、不做清单、持仓管理），不含暂停项和任何成绩；
//! 导入的文件可能来自别人：只认这个格式与不高于当前的格式版本，清理文本，按发布标准校验，所有形态一律设为「观察中」。

use crate::handbook::{sanitize_handbook, sanitize_handbook_text, validate_handbook_for_publish, Handbook, MAX_NAME_CHARS, SETUP_STATUS_OBSERVING};
use serde::Serialize;
use serde_json::Value;

pub const HANDBOOK_EXPORT_FORMAT: &str = "desic-trader-handbook";
pub const HANDBOOK_EXPORT_VERSION: u64 = 1;
/// 导入文件的大小上限。
pub const MAX_HANDBOOK_IMPORT_BYTES: usize = 512 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportDocument<'a> {
    format: &'a str,
    format_version: u64,
    name: &'a str,
    exported_at: i64,
    handbook: Handbook,
}

/// 导出文件内容（带缩进的 JSON）。暂停项属于这台电脑上的成绩，不导出。
pub fn export_handbook_document(name: &str, handbook: &Handbook, exported_at: i64) -> Result<String, String> {
    let mut handbook = handbook.clone();
    handbook.paused.clear();
    serde_json::to_string_pretty(&ExportDocument {
        format: HANDBOOK_EXPORT_FORMAT,
        format_version: HANDBOOK_EXPORT_VERSION,
        name,
        exported_at,
        handbook,
    })
    .map_err(|err| err.to_string())
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportedHandbook {
    pub name: String,
    pub handbook: Handbook,
    /// 导入时做过的调整（去掉了暂停项、改成观察中的形态数等），给用户看。
    pub warnings: Vec<String>,
}

/// 解析导入文件：拒绝未知格式、更高的格式版本、超大文件和不合规的内容；忽略未知字段。
pub fn parse_handbook_import(bytes: &[u8]) -> Result<ImportedHandbook, String> {
    if bytes.len() > MAX_HANDBOOK_IMPORT_BYTES {
        return Err(format!("文件太大（上限 {} KB）", MAX_HANDBOOK_IMPORT_BYTES / 1024));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 文本".to_string())?;
    let text = text.trim_start_matches('\u{FEFF}');
    let document = serde_json::from_str::<Value>(text).map_err(|error| format!("文件不是有效的 JSON：{error}"))?;
    if document.get("format").and_then(Value::as_str) != Some(HANDBOOK_EXPORT_FORMAT) {
        return Err("这不是 Desic 交易手册文件".to_string());
    }
    let version = document.get("formatVersion").and_then(Value::as_u64).ok_or_else(|| "文件缺少格式版本".to_string())?;
    if version > HANDBOOK_EXPORT_VERSION {
        return Err(format!("这个文件来自更新版本的应用（格式版本 {version}），请先升级应用"));
    }
    let raw = document.get("handbook").cloned().ok_or_else(|| "文件里没有手册内容".to_string())?;
    let mut handbook = serde_json::from_value::<Handbook>(raw).map_err(|error| format!("手册内容格式不对：{error}"))?;
    let mut warnings = Vec::new();
    if !handbook.paused.is_empty() {
        warnings.push(format!("文件里的 {} 个暂停范围没有导入", handbook.paused.len()));
        handbook.paused.clear();
    }
    let live = handbook.setups.iter().filter(|setup| setup.status != SETUP_STATUS_OBSERVING).count();
    for setup in &mut handbook.setups {
        setup.status = SETUP_STATUS_OBSERVING.to_string();
    }
    if live > 0 {
        warnings.push(format!("{live} 个形态已设为「观察中」：先看影子结果，再决定要不要启用"));
    }
    let handbook = sanitize_handbook(handbook);
    validate_handbook_for_publish(&handbook)?;
    let name = sanitize_handbook_text(document.get("name").and_then(Value::as_str).unwrap_or_default(), true)
        .chars()
        .take(MAX_NAME_CHARS)
        .collect::<String>();
    Ok(ImportedHandbook {
        name: if name.is_empty() { "导入的手册".to_string() } else { name },
        handbook,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handbook::{default_handbook, PausedSetup};

    #[test]
    fn export_then_import_round_trips_as_observing_without_pauses() {
        let mut handbook = default_handbook();
        handbook.paused.push(PausedSetup { setup_id: "range_edge".into(), regime: None, side: None, reason: "x".into(), paused_at: 1 });
        let text = export_handbook_document("我的突破打法", &handbook, 1_791_200_000_000).unwrap();
        assert!(text.contains("\"format\": \"desic-trader-handbook\"") && !text.contains("pausedAt"));
        let imported = parse_handbook_import(text.as_bytes()).unwrap();
        assert_eq!(imported.name, "我的突破打法");
        assert!(imported.handbook.setups.iter().all(|setup| setup.status == SETUP_STATUS_OBSERVING));
        assert!(imported.handbook.paused.is_empty());
        let mut expected = handbook.clone();
        expected.paused.clear();
        for setup in &mut expected.setups {
            setup.status = SETUP_STATUS_OBSERVING.into();
        }
        assert_eq!(imported.handbook, expected, "content survives the round trip");
        assert!(imported.warnings.iter().any(|warning| warning.contains("观察中")));
    }

    #[test]
    fn imports_reject_foreign_newer_oversized_and_invalid_files() {
        let good = export_handbook_document("x", &default_handbook(), 1).unwrap();
        assert!(parse_handbook_import(b"not json").is_err());
        assert!(parse_handbook_import(br#"{"format":"other","formatVersion":1,"handbook":{}}"#).unwrap_err().contains("不是 Desic"));
        let newer = good.replace("\"formatVersion\": 1", "\"formatVersion\": 2");
        assert!(parse_handbook_import(newer.as_bytes()).unwrap_err().contains("更新版本"));
        assert!(parse_handbook_import(&vec![b' '; MAX_HANDBOOK_IMPORT_BYTES + 1]).unwrap_err().contains("太大"));
        let bad_id = good.replace("\"id\": \"trend_pullback\"", "\"id\": \"Trend Pullback\"");
        assert!(parse_handbook_import(bad_id.as_bytes()).is_err(), "publish validation applies");
        // 未知字段忽略；控制字符与零宽字符清掉；BOM 可以有。
        let noisy = good.replacen("\"name\": \"x\"", "\"name\": \"x\\u200b\\u0007\", \"extra\": 1", 1);
        let imported = parse_handbook_import(format!("\u{FEFF}{noisy}").as_bytes()).unwrap();
        assert_eq!(imported.name, "x");
    }
}
