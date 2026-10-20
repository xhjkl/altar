use serde::{Deserialize, Serialize};
use std::ops::Range;

/// Browser-measured geometry; presentation sizes and padding belong to the frontend.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    /// None aligns to the padded tail; a position preserves the user's scroll gesture.
    pub top: Option<f64>,
    pub height: f64,
    pub inset_top: f64,
    pub row_height: f64,
    pub padding_top: f64,
    pub padding_bottom: f64,
    pub overscan: usize,
}

/// Visible rows plus a small margin; only their contents cross IPC.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowWindow {
    #[serde(skip)]
    range: Range<usize>,
    pub row_height: f64,
    pub offset: f64,
    pub scroll_top: f64,
    pub total_height: f64,
    /// Last row's top, excluding the breather; None only for an empty collection.
    pub tail_top: Option<f64>,
}

impl RowWindow {
    /// Project a collection while preserving manual positions at the tail boundary.
    fn new(total: usize, viewport: &Viewport) -> Result<Self, String> {
        if [
            viewport.top.unwrap_or(0.0),
            viewport.height,
            viewport.inset_top,
            viewport.row_height,
            viewport.padding_top,
            viewport.padding_bottom,
        ]
        .iter()
        .any(|value| !value.is_finite())
            || viewport.row_height <= 0.0
        {
            return Err("The viewport needs finite dimensions and a positive row height.".into());
        }
        let row_height = viewport.row_height;
        // Bounding IPC even for malformed or excessively large browser measurements.
        let height = viewport.height.clamp(0.0, row_height * 300.0);
        let inset_top = viewport.inset_top.clamp(0.0, height);
        let (padding_top, padding_bottom) = if total == 0 {
            (0.0, 0.0)
        } else {
            (
                viewport.padding_top.max(0.0),
                viewport.padding_bottom.max(0.0),
            )
        };
        let total_height = inset_top + padding_top + total as f64 * row_height + padding_bottom;
        if !total_height.is_finite() {
            return Err("The scroll extent exceeds finite dimensions.".into());
        }
        let max_top = (total_height - height).max(0.0);
        let scroll_top = viewport.top.unwrap_or(max_top).clamp(0.0, max_top);
        let tail_top = total
            .checked_sub(1)
            .map(|last| inset_top + padding_top + last as f64 * row_height);
        let visible = ((height - inset_top) / row_height).ceil() as usize;
        let overscan = viewport.overscan.min(visible.div_ceil(4)).min(4);
        // Chrome occludes its inset; the breather scrolls with the rows.
        let first = (((scroll_top - padding_top).max(0.0) / row_height).floor() as usize)
            .saturating_sub(overscan)
            .min(total);
        let end = (((scroll_top + height - inset_top - padding_top).max(0.0) / row_height).ceil()
            as usize)
            .saturating_add(overscan)
            .min(total);
        let range = if visible == 0 {
            first..first
        } else {
            first..end
        };
        Ok(Self {
            range,
            row_height,
            offset: inset_top + padding_top + first as f64 * row_height,
            scroll_top,
            total_height,
            tail_top,
        })
    }
}

/// Semantic column roles; CSS sizing and responsive visibility stay in the browser.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ColumnKind {
    Time,
    Unit,
    Severity,
    Message,
    Duration,
    Value { characters: usize },
}

#[derive(Serialize)]
pub struct Column {
    pub name: String,
    #[serde(flatten)]
    pub kind: ColumnKind,
}

/// Bound list-cell previews; full values remain available through row inspection.
pub fn preview(value: &str) -> String {
    let mut characters = value.chars();
    let mut text: String = characters.by_ref().take(512).collect();
    if characters.next().is_some() {
        text.push('…');
    }
    text
}

#[derive(Serialize)]
pub struct Row {
    pub id: usize,
    pub cells: Vec<String>,
    pub tone: &'static str,
}

#[derive(Serialize)]
pub struct Frame {
    pub columns: Vec<Column>,
    pub rows: Vec<Row>,
    pub total: usize,
    pub pending: usize,
    /// The collection sequence this frame reflects; pausing freezes later requests at it.
    pub tick: usize,
    pub window: RowWindow,
}

impl Frame {
    /// Materialize only the scroll window, regardless of the source's row content.
    pub fn new(
        total: usize,
        pending: usize,
        tick: usize,
        viewport: &Viewport,
        columns: Vec<Column>,
        row: impl FnMut(usize) -> Row,
    ) -> Result<Self, String> {
        let window = RowWindow::new(total, viewport)?;
        let rows = window.range.clone().map(row).collect();
        Ok(Self {
            columns,
            rows,
            total,
            pending,
            tick,
            window,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_bound_multibyte_payloads_without_changing_short_values() {
        assert_eq!(preview(""), "");
        assert_eq!(preview("first\nsecond"), "first\nsecond");
        let value = "界".repeat(512);
        assert_eq!(preview(&value), value);
        assert_eq!(preview(&(value.clone() + "extra")), value + "…");
    }

    #[test]
    fn windows_cover_visible_rows_with_a_proportionate_margin() {
        for total in [0, 1, 3, 100, 12_480] {
            for height in [0.0, 40.0, 600.0, 10_000.0] {
                for top in [Some(-100.0), Some(0.0), Some(721.0), Some(f64::MAX), None] {
                    let viewport = Viewport {
                        top,
                        height,
                        inset_top: 88.0,
                        row_height: 36.0,
                        padding_top: 72.0,
                        padding_bottom: 108.0,
                        overscan: 3,
                    };
                    let window = RowWindow::new(total, &viewport).unwrap();
                    let visible_height = height.min(10_800.0) - height.min(88.0);
                    let visible = (visible_height / 36.0).ceil() as usize;
                    assert!(window.range.start <= window.range.end);
                    assert!(window.range.end <= total);
                    assert!(window.range.len() <= visible + 2 * 3.min(visible.div_ceil(4)) + 1);
                    if visible == 0 {
                        assert!(window.range.is_empty());
                    }
                    assert!(window.scroll_top >= 0.0);
                    assert!(window.scroll_top <= (window.total_height - height).max(0.0));
                    for row in 0..total {
                        let row_top = height.min(88.0) + 72.0 + row as f64 * 36.0;
                        let visible = visible_height > 0.0
                            && row_top < window.scroll_top + height
                            && row_top + 36.0 > window.scroll_top + height.min(88.0);
                        if visible {
                            assert!(window.range.contains(&row));
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn invalid_viewports_are_rejected_before_projection() {
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for field in 0..6 {
                let mut viewport = Viewport {
                    top: Some(0.0),
                    height: 600.0,
                    inset_top: 88.0,
                    row_height: 36.0,
                    padding_top: 72.0,
                    padding_bottom: 108.0,
                    overscan: usize::MAX,
                };
                match field {
                    0 => viewport.top = Some(invalid),
                    1 => viewport.height = invalid,
                    2 => viewport.inset_top = invalid,
                    3 => viewport.row_height = invalid,
                    4 => viewport.padding_top = invalid,
                    _ => viewport.padding_bottom = invalid,
                }
                assert!(RowWindow::new(100, &viewport).is_err());
            }
        }
    }
}
