use super::Db;
use serde::Serialize;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsBucket {
    pub key: String,
    pub created: i64,
    pub closed: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AverageTimeInState {
    pub working: f64,
    pub idle: f64,
    pub unread: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorMetrics {
    pub avg_response_time: Option<f64>,
    pub avg_dwell_time: Option<f64>,
    pub switches_per_hour: Option<f64>,
    pub focus_score: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoAnalytics {
    pub task_buckets: Vec<AnalyticsBucket>,
    pub bucket_size: String,
    pub has_data: bool,
    pub avg_time_in_state: AverageTimeInState,
    pub operator_metrics: OperatorMetrics,
    pub has_operator_data: bool,
}

struct AnalyticsItem {
    id: String,
    created_at: String,
    closed_at: Option<String>,
    unread_at: Option<String>,
}

struct ActivityLogRow {
    pipeline_item_id: String,
    activity: String,
    seconds: i64,
}

struct OperatorEventRow {
    event_type: String,
    pipeline_item_id: Option<String>,
    created_at: String,
}

impl Db {
    pub fn repo_analytics(&self, repo_id: &str) -> Result<RepoAnalytics, rusqlite::Error> {
        let items = self.list_analytics_items(repo_id)?;
        if items.is_empty() {
            return Ok(empty_analytics());
        }

        let bucket_size = detect_bucket_size(&items[0].created_at);
        let task_buckets = build_task_buckets(&items, &bucket_size);
        let avg_time_in_state = self.average_time_in_state(
            repo_id,
            &items.iter().filter(|item| item.closed_at.is_some()).count(),
        )?;
        let operator_events = self.list_analytics_operator_events(repo_id)?;
        let has_operator_data = operator_events
            .iter()
            .any(|event| event.event_type == "task_selected");
        let operator_metrics = if has_operator_data {
            compute_operator_metrics(&operator_events, &items)
        } else {
            empty_operator_metrics()
        };

        Ok(RepoAnalytics {
            task_buckets,
            bucket_size,
            has_data: true,
            avg_time_in_state,
            operator_metrics,
            has_operator_data,
        })
    }

    fn list_analytics_items(&self, repo_id: &str) -> Result<Vec<AnalyticsItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, created_at, closed_at, unread_at
             FROM pipeline_item
             WHERE repo_id = ?
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([repo_id], |row| {
            Ok(AnalyticsItem {
                id: row.get(0)?,
                created_at: row.get(1)?,
                closed_at: row.get(2)?,
                unread_at: row.get(3)?,
            })
        })?;
        rows.collect()
    }

    fn average_time_in_state(
        &self,
        repo_id: &str,
        closed_count: &usize,
    ) -> Result<AverageTimeInState, rusqlite::Error> {
        if *closed_count == 0 {
            return Ok(AverageTimeInState {
                working: 0.0,
                idle: 0.0,
                unread: 0.0,
            });
        }

        let mut stmt = self.conn.prepare(
            "SELECT al.pipeline_item_id, al.activity, al.seconds
             FROM activity_log al
             JOIN pipeline_item pi ON al.pipeline_item_id = pi.id
             WHERE pi.repo_id = ? AND pi.closed_at IS NOT NULL",
        )?;
        let rows = stmt.query_map([repo_id], |row| {
            Ok(ActivityLogRow {
                pipeline_item_id: row.get(0)?,
                activity: row.get(1)?,
                seconds: row.get(2)?,
            })
        })?;
        let mut grouped: HashMap<String, HashMap<String, i64>> = HashMap::new();
        for row in rows {
            let row = row?;
            grouped
                .entry(row.pipeline_item_id)
                .or_default()
                .entry(row.activity)
                .and_modify(|seconds| *seconds += row.seconds)
                .or_insert(row.seconds);
        }

        let task_count = grouped.len() as f64;
        if task_count == 0.0 {
            return Ok(AverageTimeInState {
                working: 0.0,
                idle: 0.0,
                unread: 0.0,
            });
        }

        let mut working = 0_i64;
        let mut idle = 0_i64;
        let mut unread = 0_i64;
        for states in grouped.values() {
            working += states.get("working").copied().unwrap_or(0);
            idle += states.get("idle").copied().unwrap_or(0);
            unread += states.get("unread").copied().unwrap_or(0);
        }

        Ok(AverageTimeInState {
            working: working as f64 / task_count,
            idle: idle as f64 / task_count,
            unread: unread as f64 / task_count,
        })
    }

    fn list_analytics_operator_events(
        &self,
        repo_id: &str,
    ) -> Result<Vec<OperatorEventRow>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT event_type, pipeline_item_id, created_at
             FROM operator_event
             WHERE repo_id = ? OR repo_id IS NULL
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([repo_id], |row| {
            Ok(OperatorEventRow {
                event_type: row.get(0)?,
                pipeline_item_id: row.get(1)?,
                created_at: row.get(2)?,
            })
        })?;
        rows.collect()
    }
}

fn empty_analytics() -> RepoAnalytics {
    RepoAnalytics {
        task_buckets: Vec::new(),
        bucket_size: "daily".to_string(),
        has_data: false,
        avg_time_in_state: AverageTimeInState {
            working: 0.0,
            idle: 0.0,
            unread: 0.0,
        },
        operator_metrics: empty_operator_metrics(),
        has_operator_data: false,
    }
}

fn empty_operator_metrics() -> OperatorMetrics {
    OperatorMetrics {
        avg_response_time: None,
        avg_dwell_time: None,
        switches_per_hour: None,
        focus_score: None,
    }
}

#[derive(Clone, Copy)]
struct ParsedDateTime {
    year: i32,
    month: u32,
    day: u32,
    hour: i64,
    minute: i64,
    second: i64,
}

impl ParsedDateTime {
    fn epoch_days(self) -> i64 {
        days_from_civil(self.year, self.month, self.day)
    }

    fn timestamp_millis(self) -> i64 {
        ((self.epoch_days() * 86_400) + (self.hour * 3_600) + (self.minute * 60) + self.second)
            * 1000
    }
}

fn parse_datetime(value: &str) -> Option<ParsedDateTime> {
    let date = value.get(0..10)?;
    let year = date.get(0..4)?.parse::<i32>().ok()?;
    let month = date.get(5..7)?.parse::<u32>().ok()?;
    let day = date.get(8..10)?.parse::<u32>().ok()?;
    let time = value.get(11..19).unwrap_or("00:00:00");
    let hour = time.get(0..2)?.parse::<i64>().ok()?;
    let minute = time.get(3..5)?.parse::<i64>().ok()?;
    let second = time.get(6..8)?.parse::<i64>().ok()?;
    Some(ParsedDateTime {
        year,
        month,
        day,
        hour,
        minute,
        second,
    })
}

// Howard Hinnant's civil date algorithm. Returns days since 1970-01-01.
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = year - if month <= 2 { 1 } else { 0 };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i32 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146_097 + doe - 719_468) as i64
}

fn now_timestamp_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn detect_bucket_size(min_date: &str) -> String {
    let Some(min) = parse_datetime(min_date) else {
        return "daily".to_string();
    };
    let days = (now_timestamp_millis() - min.timestamp_millis()) / 86_400_000;
    if days < 14 {
        "daily".to_string()
    } else if days < 90 {
        "weekly".to_string()
    } else {
        "monthly".to_string()
    }
}

fn bucket_key(date_str: &str, size: &str) -> String {
    let Some(date_time) = parse_datetime(date_str) else {
        return date_str.chars().take(10).collect();
    };
    match size {
        "weekly" => {
            // 1970-01-01 was a Thursday, so add 3 to get Monday-based weekday.
            let weekday = (date_time.epoch_days() + 3).rem_euclid(7);
            let monday_days = date_time.epoch_days() - weekday;
            civil_from_days(monday_days)
        }
        "monthly" => format!("{:04}-{:02}", date_time.year, date_time.month),
        _ => format!(
            "{:04}-{:02}-{:02}",
            date_time.year, date_time.month, date_time.day
        ),
    }
}

fn civil_from_days(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    format!("{year:04}-{month:02}-{day:02}")
}

fn build_task_buckets(items: &[AnalyticsItem], bucket_size: &str) -> Vec<AnalyticsBucket> {
    let mut buckets: HashMap<String, (i64, i64)> = HashMap::new();
    for item in items {
        let key = bucket_key(&item.created_at, bucket_size);
        let entry = buckets.entry(key).or_insert((0, 0));
        entry.0 += 1;
    }
    for item in items {
        if let Some(closed_at) = item.closed_at.as_deref() {
            let key = bucket_key(closed_at, bucket_size);
            let entry = buckets.entry(key).or_insert((0, 0));
            entry.1 += 1;
        }
    }

    let mut keys = buckets.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    keys.into_iter()
        .map(|key| {
            let (created, closed) = buckets.get(&key).copied().unwrap_or((0, 0));
            AnalyticsBucket {
                key,
                created,
                closed,
            }
        })
        .collect()
}

fn event_time(event: &OperatorEventRow) -> Option<i64> {
    parse_datetime(&event.created_at).map(|dt| dt.timestamp_millis())
}

fn compute_operator_metrics(
    events: &[OperatorEventRow],
    items: &[AnalyticsItem],
) -> OperatorMetrics {
    let dwells = compute_dwells(events);
    let dwell_values = dwells.values().copied().collect::<Vec<_>>();
    let avg_dwell_time = average(&dwell_values);
    let active_hours = compute_active_hours(events);
    let switch_count = compute_switch_count(events);
    let switches_per_hour = if active_hours > 0.0 {
        Some(switch_count as f64 / active_hours)
    } else {
        None
    };

    let total_dwell = dwell_values.iter().sum::<f64>();
    let focus_dwell = dwell_values
        .iter()
        .filter(|dwell| **dwell > 30.0)
        .sum::<f64>();
    let focus_score = if total_dwell > 0.0 {
        Some(focus_dwell / total_dwell)
    } else {
        None
    };

    let response_values = compute_response_times(events, items)
        .into_values()
        .collect::<Vec<_>>();

    OperatorMetrics {
        avg_response_time: average(&response_values),
        avg_dwell_time,
        switches_per_hour,
        focus_score,
    }
}

fn compute_dwells(events: &[OperatorEventRow]) -> HashMap<String, f64> {
    let mut dwells = HashMap::new();
    let mut active_item_id: Option<String> = None;
    let mut segment_start: Option<i64> = None;
    let mut app_visible = true;

    for event in events {
        let Some(t) = event_time(event) else {
            continue;
        };
        match event.event_type.as_str() {
            "task_selected" => {
                if let (Some(item_id), Some(start)) = (active_item_id.as_ref(), segment_start) {
                    if app_visible {
                        let duration = ((t - start).max(0) as f64) / 1000.0;
                        *dwells.entry(item_id.clone()).or_insert(0.0) += duration;
                    }
                }
                active_item_id = event.pipeline_item_id.clone();
                segment_start = if app_visible { Some(t) } else { None };
            }
            "app_blur" => {
                if let (Some(item_id), Some(start)) = (active_item_id.as_ref(), segment_start) {
                    let duration = ((t - start).max(0) as f64) / 1000.0;
                    *dwells.entry(item_id.clone()).or_insert(0.0) += duration;
                }
                segment_start = None;
                app_visible = false;
            }
            "app_focus" => {
                app_visible = true;
                if active_item_id.is_some() {
                    segment_start = Some(t);
                }
            }
            _ => {}
        }
    }

    if let (Some(item_id), Some(start)) = (active_item_id, segment_start) {
        if app_visible {
            let now = now_timestamp_millis();
            let duration = ((now - start).max(0) as f64) / 1000.0;
            *dwells.entry(item_id).or_insert(0.0) += duration;
        }
    }

    dwells
}

fn compute_active_hours(events: &[OperatorEventRow]) -> f64 {
    let Some(first) = events.first().and_then(event_time) else {
        return 0.0;
    };
    let now = now_timestamp_millis();
    let mut total_blur = 0_i64;
    let mut blur_start: Option<i64> = None;

    for event in events {
        let Some(t) = event_time(event) else {
            continue;
        };
        match event.event_type.as_str() {
            "app_blur" => blur_start = Some(t),
            "app_focus" => {
                if let Some(start) = blur_start {
                    total_blur += t - start;
                    blur_start = None;
                }
            }
            _ => {}
        }
    }
    if let Some(start) = blur_start {
        total_blur += now - start;
    }

    ((now - first - total_blur).max(3600) as f64) / 3_600_000.0
}

fn compute_switch_count(events: &[OperatorEventRow]) -> i64 {
    let mut count = 0;
    let mut previous_item_id: Option<&str> = None;
    for event in events {
        if event.event_type != "task_selected" {
            continue;
        }
        let Some(item_id) = event.pipeline_item_id.as_deref() else {
            continue;
        };
        if previous_item_id.is_some_and(|previous| previous != item_id) {
            count += 1;
        }
        previous_item_id = Some(item_id);
    }
    count
}

fn compute_response_times(
    events: &[OperatorEventRow],
    items: &[AnalyticsItem],
) -> HashMap<String, f64> {
    let mut selection_times: HashMap<&str, Vec<i64>> = HashMap::new();
    for event in events {
        if event.event_type != "task_selected" {
            continue;
        }
        let (Some(item_id), Some(t)) = (event.pipeline_item_id.as_deref(), event_time(event))
        else {
            continue;
        };
        selection_times.entry(item_id).or_default().push(t);
    }

    let mut responses = HashMap::new();
    for item in items {
        let Some(unread_at) = item.unread_at.as_deref().and_then(parse_datetime) else {
            continue;
        };
        let unread_at = unread_at.timestamp_millis();
        let Some(selections) = selection_times.get(item.id.as_str()) else {
            continue;
        };
        let Some(first_after) = selections.iter().find(|t| **t > unread_at) else {
            continue;
        };
        responses.insert(
            item.id.clone(),
            ((*first_after - unread_at) as f64) / 1000.0,
        );
    }
    responses
}

fn average(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        None
    } else {
        Some(values.iter().sum::<f64>() / values.len() as f64)
    }
}
