use crate::protocol::{
    Detail, Field, FrameRequest, Machine, Metrics, Query, Selection, TraceSpan, View, Workspace,
};
use crate::stream::{Column, ColumnKind, Frame, Row, Viewport};

/// Return deterministic sample content without remote I/O.
pub fn workspace(scene: &str) -> Workspace {
    let logs = View {
        id: "activity".into(),
        name: "All activity".into(),
        query: Query::Logs {
            filter: String::new(),
        },
    };
    let orders = View {
        id: "orders".into(),
        name: "Recent orders".into(),
        query: Query::Sql {
            source: String::new(),
            statement: "SELECT id, customer, status, total FROM orders LIMIT 100;".into(),
            run: 0,
        },
    };
    let mut machines = vec![
        Machine {
            id: "production".into(),
            name: "prod-eu-01".into(),
            online: true,
            views: vec![
                logs.clone(),
                View {
                    id: "errors".into(),
                    name: "Errors & warnings".into(),
                    query: Query::Logs {
                        filter: "level:warn,error".into(),
                    },
                },
                View {
                    id: "slow".into(),
                    name: "Slow requests".into(),
                    query: Query::Logs {
                        filter: "duration:>100ms".into(),
                    },
                },
                orders.clone(),
            ],
        },
        Machine {
            id: "worker".into(),
            name: "worker-us-02".into(),
            online: true,
            views: vec![
                logs.clone(),
                View {
                    id: "jobs".into(),
                    name: "Background jobs".into(),
                    query: Query::Logs {
                        filter: "service:worker".into(),
                    },
                },
            ],
        },
        Machine {
            id: "staging".into(),
            name: "staging-01".into(),
            online: false,
            views: vec![logs, orders],
        },
    ];
    if scene == "empty" {
        machines[0].views[0].query = Query::Logs {
            filter: "request:missing".into(),
        };
    }
    Workspace {
        machines,
        selection: Selection {
            machine: if scene == "offline" {
                "staging"
            } else {
                "production"
            }
            .into(),
            view: if scene == "sql" { "orders" } else { "activity" }.into(),
        },
        tick: if scene == "paused" { 18 } else { 0 },
        paused_at: if matches!(scene, "paused" | "trace") {
            Some(0)
        } else {
            None
        },
        inspect: if scene == "trace" { Some(6) } else { None },
    }
}

struct Event {
    level: &'static str,
    service: &'static str,
    message: &'static str,
    duration: u32,
}

const EVENTS: [Event; 12] = [
    Event {
        level: "info",
        service: "api",
        message: "GET /v1/health → 200",
        duration: 2,
    },
    Event {
        level: "info",
        service: "api",
        message: "GET /v1/orders?limit=25 → 200",
        duration: 24,
    },
    Event {
        level: "info",
        service: "postgres",
        message: "SELECT orders · 25 rows returned",
        duration: 8,
    },
    Event {
        level: "info",
        service: "worker",
        message: "invoice.created · job completed",
        duration: 42,
    },
    Event {
        level: "debug",
        service: "cache",
        message: "Session refreshed · ttl=3600s",
        duration: 1,
    },
    Event {
        level: "info",
        service: "api",
        message: "POST /v1/orders → 201",
        duration: 87,
    },
    Event {
        level: "error",
        service: "api",
        message: "POST /v1/payments → 502 · upstream timed out",
        duration: 1250,
    },
    Event {
        level: "warn",
        service: "postgres",
        message: "Slow query · SELECT inventory WHERE sku = $1",
        duration: 184,
    },
    Event {
        level: "info",
        service: "worker",
        message: "email.receipt · delivered to customer",
        duration: 63,
    },
    Event {
        level: "info",
        service: "api",
        message: "GET /v1/products → 200 · cache hit",
        duration: 4,
    },
    Event {
        level: "debug",
        service: "worker",
        message: "Queue heartbeat · 3 workers available",
        duration: 1,
    },
    Event {
        level: "info",
        service: "api",
        message: "GET /v1/customers/284 → 200",
        duration: 19,
    },
];

fn matches(event: &Event, query: &str) -> bool {
    query.split_whitespace().all(|term| {
        if let Some(levels) = term.strip_prefix("level:") {
            return levels.split(',').any(|level| level == event.level);
        }
        if let Some(service) = term.strip_prefix("service:") {
            return event.service.contains(service);
        }
        if term == "duration:>100ms" {
            return event.duration > 100;
        }
        event.message.to_lowercase().contains(term)
            || event.service.contains(term)
            || event.level.contains(term)
    })
}

fn time(id: usize) -> String {
    let milliseconds = (14 * 3600 + 32 * 60) * 1000 + id * 137;
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        milliseconds / 3_600_000 % 24,
        milliseconds / 60_000 % 60,
        milliseconds / 1000 % 60,
        milliseconds % 1000
    )
}

/// Return only the requested window of fixture rows.
pub fn render_frame(request: FrameRequest) -> Result<Frame, String> {
    match &request.query {
        Query::Sql { .. } => sql_frame(&request.viewport),
        Query::Logs { filter } => log_frame(&request, filter),
    }
}

fn log_frame(request: &FrameRequest, filter: &str) -> Result<Frame, String> {
    let filter = filter.to_lowercase();
    let matching: Vec<_> = EVENTS
        .iter()
        .enumerate()
        .filter(|(_, event)| matches(event, &filter))
        .map(|(index, _)| index)
        .collect();
    let tick = if request.machine == "staging" {
        0
    } else {
        request.tick.min(100_000)
    };
    let count = |tick| {
        let count = 12_480 + tick * 2;
        count / EVENTS.len() * matching.len()
            + matching
                .iter()
                .filter(|&&index| index < count % EVENTS.len())
                .count()
    };
    let total = count(request.paused_at.unwrap_or(tick).min(tick));
    let columns = vec![
        Column {
            name: "Time · UTC".into(),
            kind: ColumnKind::Time,
        },
        Column {
            name: "Duration".into(),
            kind: ColumnKind::Duration,
        },
        Column {
            name: "Service".into(),
            kind: ColumnKind::Unit,
        },
        Column {
            name: String::new(),
            kind: ColumnKind::Severity,
        },
        Column {
            name: "Message".into(),
            kind: ColumnKind::Message,
        },
    ];
    Frame::new(
        total,
        count(tick) - total,
        tick,
        &request.viewport,
        columns,
        |position| {
            let id = position / matching.len() * EVENTS.len() + matching[position % matching.len()];
            let event = &EVENTS[id % EVENTS.len()];
            Row {
                id,
                cells: vec![
                    time(id),
                    format!("{} ms", event.duration),
                    event.service.into(),
                    event.level.into(),
                    event.message.into(),
                ],
                tone: event.level,
            }
        },
    )
}

/// Map result positions to the same order IDs in the table and inspector.
fn order_id(position: usize) -> usize {
    10428_usize.saturating_sub(position)
}

/// Project the fixed sample result; viewport changes never execute a SQL statement.
fn sql_frame(viewport: &Viewport) -> Result<Frame, String> {
    let columns = vec![
        Column {
            name: "id".into(),
            kind: ColumnKind::Value { characters: 5 },
        },
        Column {
            name: "customer".into(),
            kind: ColumnKind::Value { characters: 12 },
        },
        Column {
            name: "status".into(),
            kind: ColumnKind::Value { characters: 7 },
        },
        Column {
            name: "total".into(),
            kind: ColumnKind::Value { characters: 7 },
        },
    ];
    let customers = [
        "Maya Chen",
        "Oliver Grant",
        "Nina Petrova",
        "Luca Rossi",
        "Emma Wilson",
    ];
    Frame::new(100, 0, 0, viewport, columns, |position| Row {
        id: position,
        cells: vec![
            order_id(position).to_string(),
            customers[position % customers.len()].into(),
            if position % 7 == 0 { "pending" } else { "paid" }.into(),
            format!("${}.00", 24 + position * 13 % 280),
        ],
        tone: "info",
    })
}

pub fn metrics(machine: &str, tick: usize) -> Metrics {
    let tick = if machine == "staging" { 0 } else { tick };
    let cpu: Vec<_> = (0..32).map(|i| 18 + (i * 7 + tick * 3) % 23).collect();
    let memory: Vec<_> = (0..32).map(|i| 55 + (i * 3 + tick) % 6).collect();
    Metrics {
        machine: machine.into(),
        cpu,
        memory,
        disk: 42,
        cpu_cores: 4,
        memory_gb: 8.0,
        disk_gb: 80.0,
        uptime: "12d 4h 32m".into(),
        last_sample: (machine == "staging").then(|| "12 minutes ago".into()),
    }
}

pub fn inspect_row(machine: &str, query: Query, id: usize) -> Detail {
    match query {
        Query::Sql { .. } => Detail {
            title: format!("Order #{}", order_id(id)),
            tone: "info",
            fields: vec![
                Field::read_only("database", "commerce"),
                Field::read_only("table", "public.orders"),
                Field::read_only("source", machine),
                Field::read_only("result", "Sample data · read only"),
            ],
            trace: Vec::new(),
        },
        Query::Logs { .. } => {
            let event = &EVENTS[id % EVENTS.len()];
            Detail {
                title: event.message.into(),
                tone: event.level,
                fields: vec![
                    Field::read_only("timestamp", format!("2026-10-06 {} UTC", time(id))),
                    Field::read_only("service", event.service),
                    Field::read_only("host", machine),
                    Field::read_only("trace_id", format!("a8f291e4c0d7{:08x}", id)),
                ],
                trace: vec![
                    TraceSpan {
                        name: "http.request".into(),
                        duration: format!("{} ms", event.duration),
                        start: 0,
                        width: 100,
                    },
                    TraceSpan {
                        name: "postgres.query".into(),
                        duration: format!("{} ms", event.duration / 5),
                        start: 8,
                        width: 20,
                    },
                    TraceSpan {
                        name: "upstream.request".into(),
                        duration: format!("{} ms", event.duration * 3 / 5),
                        start: 32,
                        width: 60,
                    },
                ],
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> FrameRequest {
        FrameRequest {
            machine: "production".into(),
            query: Query::Logs {
                filter: String::new(),
            },
            tick: 0,
            paused_at: Some(0),
            viewport: Viewport {
                top: Some(0.0),
                height: 600.0,
                inset_top: 0.0,
                row_height: 36.0,
                padding_top: 72.0,
                padding_bottom: 108.0,
                overscan: 3,
            },
        }
    }

    /// Run with `cargo test projection_measurement -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn projection_measurement() {
        let started = std::time::Instant::now();
        let mut bytes = 0;
        let mut rows = 0;
        for _ in 0..10_000 {
            let mut request = request();
            request.viewport.inset_top = 88.0;
            request.viewport.top = None;
            request.paused_at = None;
            let frame = render_frame(request).unwrap();
            rows = frame.rows.len();
            bytes = serde_json::to_vec(&frame).unwrap().len();
            std::hint::black_box(frame);
        }
        eprintln!(
            "projection: rows={rows}, bytes={bytes}, 10000 frames={:?}",
            started.elapsed()
        );
    }

    #[test]
    fn window_is_bounded_and_keeps_global_row_identity() {
        let mut request = request();
        request.viewport.top = Some(360_000.0);
        let frame = render_frame(request).unwrap();
        assert_eq!(frame.total, 12_480);
        assert!(frame.rows.len() <= 24);
        assert_eq!(frame.rows[0].id, 9_995);
        assert_eq!(frame.window.offset, 359_892.0);
    }

    #[test]
    fn filtering_precedes_windowing_and_empty_results_are_valid() {
        let mut request = request();
        request.query = Query::Logs {
            filter: "level:error service:api".into(),
        };
        request.paused_at = None;
        request.viewport.top = None;
        let frame = render_frame(request).unwrap();
        assert_eq!(frame.total, 1040);
        assert_eq!(frame.rows.last().unwrap().id, 12474);
        assert!(frame.rows.iter().all(|row| row.tone == "error"));
        let mut request = self::request();
        request.query = Query::Logs {
            filter: "no-matching-event".into(),
        };
        let frame = render_frame(request).unwrap();
        assert!(frame.rows.is_empty());
        assert_eq!(frame.window.total_height, 0.0);
        assert_eq!(frame.window.tail_top, None);
    }

    #[test]
    fn tail_advances_but_browsing_keeps_its_position() {
        let mut request = request();
        request.tick = 20;
        request.paused_at = None;
        request.viewport.top = None;
        let frame = render_frame(request).unwrap();
        assert_eq!(frame.rows.last().unwrap().id, 12519);
        assert_eq!(frame.window.scroll_top, frame.window.total_height - 600.0);
        let mut request = self::request();
        request.tick = 20;
        request.viewport.top = Some(720.0);
        let frame = render_frame(request).unwrap();
        assert_eq!(frame.window.scroll_top, 720.0);
        assert_eq!(frame.total, 12_480);
        assert_eq!(frame.pending, 40);
    }

    #[test]
    fn stale_scroll_offsets_are_clamped_to_the_collection() {
        let mut request = request();
        request.viewport.top = Some(f64::MAX);
        let frame = render_frame(request).unwrap();
        assert_eq!(frame.window.scroll_top, frame.window.total_height - 600.0);
    }

    #[test]
    fn log_padding_scrolls_above_the_first_row_and_below_the_live_tail() {
        let mut request = request();
        request.viewport.inset_top = 88.0;
        let frame = render_frame(request).unwrap();
        assert_eq!(frame.window.scroll_top, 0.0);
        assert_eq!(frame.rows[0].id, 0);
        assert_eq!(frame.window.offset - 88.0, 72.0);

        let mut request = self::request();
        request.viewport.inset_top = 88.0;
        request.paused_at = None;
        request.viewport.top = None;
        let frame = render_frame(request).unwrap();
        assert_eq!(
            frame.window.total_height,
            12_480.0 * 36.0 + 88.0 + 72.0 + 108.0
        );
        assert_eq!(frame.window.scroll_top, frame.window.total_height - 600.0);
        assert!(frame.rows.len() <= 20);
        assert_eq!(frame.rows.last().unwrap().id, 12_479);
        let last_bottom = frame.window.offset + frame.rows.len() as f64 * frame.window.row_height
            - frame.window.scroll_top;
        assert_eq!(600.0 - last_bottom, 108.0);
        assert_eq!(
            frame.window.tail_top.unwrap() + frame.window.row_height,
            frame.window.total_height - 108.0
        );
    }

    #[test]
    fn live_window_preserves_a_manual_position_at_the_last_row_boundary() {
        for query in ["", "level:error service:api"] {
            let mut request = request();
            request.query = Query::Logs {
                filter: query.into(),
            };
            request.viewport.inset_top = 88.0;
            request.viewport.top = None;
            let tail = render_frame(request).unwrap();
            let tail_top = tail.window.tail_top.unwrap();
            let last_id = tail.rows.last().unwrap().id;

            // Crossing from zero to one visible pixel without snapping through the breather.
            for visible_pixels in [0.0, 1.0, 36.0] {
                let mut request = self::request();
                request.query = Query::Logs {
                    filter: query.into(),
                };
                request.paused_at = None;
                request.viewport.inset_top = 88.0;
                request.viewport.top = Some(tail_top - 600.0 + visible_pixels);
                let frame = render_frame(request).unwrap();
                assert_eq!(frame.window.tail_top, Some(tail_top));
                assert_eq!(frame.rows.last().unwrap().id, last_id);
                assert_eq!(frame.window.scroll_top + 600.0 - tail_top, visible_pixels);
                assert_eq!(frame.pending, 0);
            }
        }
    }

    #[test]
    fn paused_counts_match_the_search_without_advancing_the_snapshot() {
        let mut request = request();
        request.query = Query::Logs {
            filter: "level:error service:api".into(),
        };
        request.tick = 18;
        request.viewport.top = Some(720.0);
        let frame = render_frame(request).unwrap();
        assert_eq!(frame.total, 1040);
        assert_eq!(frame.pending, 3);
        assert_eq!(frame.window.scroll_top, 720.0);

        let mut request = self::request();
        request.query = Query::Logs {
            filter: "level:error service:api".into(),
        };
        request.tick = 18;
        request.paused_at = None;
        request.viewport.top = None;
        let frame = render_frame(request).unwrap();
        assert_eq!(frame.total, 1043);
        assert_eq!(frame.pending, 0);
        assert_eq!(frame.window.scroll_top, frame.window.total_height - 600.0);
    }

    #[test]
    fn offline_sql_and_empty_searches_have_no_pending_events() {
        for (machine, query) in [
            (
                "staging",
                Query::Logs {
                    filter: String::new(),
                },
            ),
            (
                "production",
                Query::Sql {
                    source: String::new(),
                    statement: String::new(),
                    run: 0,
                },
            ),
            (
                "production",
                Query::Logs {
                    filter: "request:missing".into(),
                },
            ),
        ] {
            let mut request = request();
            request.machine = machine.into();
            request.query = query;
            request.tick = 18;
            let frame = render_frame(request).unwrap();
            assert_eq!(frame.pending, 0);
            if frame.total == 0 {
                assert_eq!(frame.window.tail_top, None);
            }
        }
    }

    #[test]
    fn sql_uses_the_same_breathers_and_bounded_projection_as_logs() {
        for top in [Some(0.0), None] {
            let mut request = request();
            request.query = Query::Sql {
                source: String::new(),
                statement: "SELECT * FROM orders".into(),
                run: 0,
            };
            request.viewport.inset_top = 88.0;
            request.viewport.top = top;
            let frame = render_frame(request).unwrap();
            assert_eq!(frame.total, 100);
            assert_eq!(frame.pending, 0);
            assert!(frame.rows.len() <= 25);
            assert_eq!(
                frame.window.total_height,
                88.0 + 72.0 + 100.0 * 36.0 + 108.0
            );
            if top.is_some() {
                assert_eq!(frame.window.offset, 88.0 + 72.0);
                assert_eq!(frame.rows[0].id, 0);
            } else {
                assert_eq!(frame.rows.last().unwrap().id, 99);
                assert_eq!(
                    frame.window.tail_top.unwrap() + 36.0 - frame.window.scroll_top,
                    600.0 - 108.0
                );
            }
        }
    }

    #[test]
    fn every_scene_resolves_to_a_machine_owned_query() {
        for scene in [
            "live", "paused", "trace", "sql", "offline", "empty", "compact",
        ] {
            let workspace = workspace(scene);
            let machine = workspace
                .machines
                .iter()
                .find(|machine| machine.id == workspace.selection.machine)
                .unwrap();
            let view = machine
                .views
                .iter()
                .find(|view| view.id == workspace.selection.view)
                .unwrap();
            let mut request = request();
            request.machine = machine.id.clone();
            request.query = view.query.clone();
            request.tick = workspace.tick;
            request.paused_at = workspace.paused_at;
            let frame = render_frame(request).unwrap();
            assert_eq!(frame.total == 0, scene == "empty");
            assert_eq!(frame.pending > 0, scene == "paused");
            if let Some(id) = workspace.inspect {
                let detail = inspect_row(&machine.id, view.query.clone(), id);
                assert_eq!(detail.tone, "error");
            }
        }
    }

    #[test]
    fn serialized_query_kind_selects_content_without_a_bookmark_id() {
        for query in [
            json!({ "kind": "sql", "source": "orders", "statement": "SELECT * FROM orders", "run": 0 }),
            json!({ "kind": "logs", "filter": "level:error" }),
        ] {
            let request: FrameRequest = serde_json::from_value(json!({
                "machine": "production", "query": query, "tick": 0, "pausedAt": null,
                "viewport": {
                    "top": 0, "height": 600, "insetTop": 88, "rowHeight": 36,
                    "paddingTop": 72, "paddingBottom": 108, "overscan": 3
                }
            }))
            .unwrap();
            let detail = inspect_row("production", request.query.clone(), 0);
            let frame = render_frame(request).unwrap();
            let frame = serde_json::to_value(frame).unwrap();
            assert_eq!(frame["window"]["offset"], 160.0);
            assert_eq!(frame["tick"], 0);
            assert!(frame["window"].get("range").is_none());
            assert_eq!(
                frame["rows"][0]["cells"].as_array().unwrap().len(),
                frame["columns"].as_array().unwrap().len()
            );
            if query["kind"] == "sql" {
                assert_eq!(frame["columns"][0]["name"], "id");
                assert!(detail.trace.is_empty());
            } else {
                assert_eq!(frame["columns"][0]["name"], "Time · UTC");
                assert_eq!(frame["columns"][1]["name"], "Duration");
                assert_eq!(frame["columns"][3]["name"], "");
                assert_eq!(frame["columns"][3]["kind"], "severity");
                assert_eq!(frame["columns"][4]["name"], "Message");
                assert_eq!(frame["rows"][0]["tone"], "error");
                assert_eq!(detail.trace.len(), 3);
            }
        }
    }

    #[test]
    fn metric_samples_keep_machine_identity_metadata_and_percentage_bounds() {
        for machine in ["production", "worker", "staging"] {
            for tick in [0, 18, 100_000] {
                let sample = metrics(machine, tick);
                assert_eq!(sample.machine, machine);
                assert_eq!(sample.cpu.len(), 32);
                assert_eq!(sample.memory.len(), 32);
                assert!(sample
                    .cpu
                    .iter()
                    .chain(&sample.memory)
                    .all(|&value| value <= 100));
                assert!(sample.disk <= 100);
                assert!(sample.cpu_cores > 0 && sample.memory_gb > 0.0 && sample.disk_gb > 0.0);
                assert_eq!(sample.last_sample.is_some(), machine == "staging");
                let wire = serde_json::to_value(sample).unwrap();
                assert!(wire["cpuCores"].is_number());
                assert!(wire["memoryGb"].is_number());
                assert!(wire["diskGb"].is_number());
                assert!(wire["uptime"].is_string());
                assert!(wire.get("lastSample").is_some());
            }
        }
        assert_eq!(metrics("staging", 0).cpu, metrics("staging", 18).cpu);
    }

    #[test]
    fn typed_details_serialize_fields_and_trace_geometry_for_both_query_kinds() {
        for query in [
            Query::Sql {
                source: String::new(),
                statement: "SELECT * FROM orders".into(),
                run: 0,
            },
            Query::Logs {
                filter: String::new(),
            },
        ] {
            let detail = inspect_row("production", query, 6);
            assert!(!detail.title.is_empty());
            for span in &detail.trace {
                assert!(u16::from(span.start) + u16::from(span.width) <= 100);
            }
            let wire = serde_json::to_value(detail).unwrap();
            assert!(wire["fields"].as_array().unwrap().iter().all(|field| {
                field["name"].is_string()
                    && field["value"].is_string()
                    && field["writable"] == false
            }));
            assert!(wire["trace"].is_array());
        }
    }
}
