import { Title } from "@solidjs/meta";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type {
  Catalog,
  CellValue,
  DbRequest,
  DbResult,
  DbResponse,
  QueryResult,
  QuerySource,
  RelationRef,
  ResultColumn,
  Row,
  RowCount,
  ScalarValue,
  UpdateTarget,
} from "~/lib/db-contract";
import { isPreviewCell, sameRelation } from "~/lib/db-contract";

type Status = {
  tone: "idle" | "busy" | "ok" | "warn";
  text: string;
};

type Editor = {
  rowIndex: number;
  column: string;
};

const PAGE_SIZE = 50;
const CONNECTION_KEY = "altar:connection";
const POSTGRES_IDENTIFIER_LIMIT = 63;
const POSTGRES_IDENTIFIER = /^[\p{L}_][\p{L}_0-9$]*$/u;
const BYTEA_INLINE_BYTES = 24;

function createBodyDismiss(active: () => boolean, action: () => void) {
  createEffect(() => {
    if (!active() || typeof document === "undefined") return;

    let armed = false;
    const arm = setTimeout(() => {
      armed = true;
    }, 0);
    const clickOutside = () => {
      if (armed) action();
    };
    const keyOutside = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      action();
    };

    document.body.addEventListener("click", clickOutside);
    document.body.addEventListener("keydown", keyOutside);
    onCleanup(() => {
      clearTimeout(arm);
      document.body.removeEventListener("click", clickOutside);
      document.body.removeEventListener("keydown", keyOutside);
    });
  });
}

function stopBodyClick(event: MouseEvent) {
  event.stopPropagation();
}

export default function Altar() {
  const [connection, setConnection] = createSignal<string | null>(null);

  onMount(() => {
    setConnection(window.sessionStorage.getItem(CONNECTION_KEY));
  });

  function connect(nextConnection: string) {
    window.sessionStorage.setItem(CONNECTION_KEY, nextConnection);
    setConnection(nextConnection);
  }

  function disconnect() {
    window.sessionStorage.removeItem(CONNECTION_KEY);
    setConnection(null);
  }

  return (
    <>
      <Title>Altar</Title>
      <Show when={connection()} keyed fallback={<ConnectScreen onConnect={connect} />}>
        {(current) => <Studio connection={current} onDisconnect={disconnect} />}
      </Show>
    </>
  );
}

function ConnectScreen(props: { onConnect: (connection: string) => void }) {
  const [draft, setDraft] = createSignal("");
  const [status, setStatus] = createSignal<Status>({ tone: "idle", text: "" });

  async function connect(event: SubmitEvent) {
    event.preventDefault();
    const rawConnection = draft().trim();
    const nextConnection = expandConnectionShortcut(rawConnection);
    if (!nextConnection) {
      setStatus({ tone: "warn", text: "enter a connection string." });
      return;
    }

    setStatus({ tone: "busy", text: "connecting" });
    try {
      await request({ type: "catalog", connection: nextConnection }, { step: "connect" });
      props.onConnect(nextConnection);
    } catch (error) {
      setStatus({ tone: "warn", text: messageOf(error) });
    }
  }

  return (
    <main class="connect-screen">
      <section class="connect-panel" aria-label="postgres connection">
        <form class="connect-card" onSubmit={connect}>
          <label class="connect-field">
            <input
              value={draft()}
              aria-label="connection string"
              placeholder="postgres://user@host/db"
              spellcheck={false}
              autocomplete="off"
              autofocus
              onInput={(event) => setDraft(event.currentTarget.value)}
            />
          </label>
          <div class="connect-actions">
            <StatusMessage status={status()} />
            <button type="submit" class="primary-button" disabled={status().tone === "busy"}>
              connect
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

function Studio(props: { connection: string; onDisconnect: () => void }) {
  const [catalog, setCatalog] = createSignal<Catalog | null>(null);
  const [sql, setSql] = createSignal("");
  const [result, setResult] = createSignal<QueryResult | null>(null);
  const [status, setStatus] = createSignal<Status>({ tone: "busy", text: "connecting" });
  const [editor, setEditor] = createSignal<Editor | null>(null);
  const [relationFilter, setRelationFilter] = createSignal("");
  const [selectedSchemaName, setSelectedSchemaName] = createSignal<string | null>(null);
  const [disconnectArmed, setDisconnectArmed] = createSignal(false);

  let abort: AbortController | null = null;
  let serial = 0;
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let editInput: HTMLTextAreaElement | undefined;

  onMount(() => {
    void loadCatalog();
  });

  onCleanup(() => {
    abort?.abort();
    if (disconnectTimer != null) clearTimeout(disconnectTimer);
  });

  const relations = createMemo(() => catalog()?.relations ?? []);
  const schemas = createMemo(() => {
    const names = Array.from(new Set(relations().map((relation) => relation.schema)));
    return names.length > 0 ? names : ["public"];
  });
  const selectedSchema = createMemo(() => {
    const names = schemas();
    const current = selectedSchemaName();
    if (current != null && names.includes(current)) return current;
    return names.includes("public") ? "public" : names[0];
  });
  const filteredRelations = createMemo(() => {
    const visible = relations().filter((relation) => relation.schema === selectedSchema());
    const query = relationFilter().trim().toLowerCase();
    if (!query) return visible;
    return visible.filter((relation) => relationSearchText(relation).includes(query));
  });
  const selectedRelation = createMemo(() => {
    const source = result()?.source;
    return source?.kind === "relation" ? source.relation : null;
  });
  const prompt = createMemo(() => {
    const relation = selectedRelation();
    return relation == null ? `${selectedSchema()}=>` : `${relation.schema}.${relation.name}=>`;
  });
  const editorContext = createMemo(() => {
    const current = result();
    const currentEditor = editor();
    if (current == null || currentEditor == null) return null;

    const row = current.rows[currentEditor.rowIndex] ?? null;
    const column = current.columns.find((item) => item.name === currentEditor.column) ?? null;
    if (row == null || column == null || !canPatchCell(row, column)) return null;

    return { row, rowIndex: currentEditor.rowIndex, column };
  });
  createBodyDismiss(() => editor() != null, cancelCellEdit);
  createEffect(() => {
    if (editorContext() == null || typeof requestAnimationFrame === "undefined") return;

    const focus = requestAnimationFrame(() => {
      editInput?.focus();
    });
    onCleanup(() => cancelAnimationFrame(focus));
  });

  async function loadCatalog() {
    setStatus({ tone: "busy", text: "loading catalog" });
    try {
      const nextCatalog = await request(
        { type: "catalog", connection: props.connection },
        { step: "load catalog" },
      );
      setCatalog(nextCatalog);
      setStatus({
        tone: nextCatalog.relations.length === 0 ? "warn" : "ok",
        text: `${nextCatalog.relations.length} relations · ${nextCatalog.durationMs}ms`,
      });
    } catch (error) {
      setStatus({ tone: "warn", text: messageOf(error) });
    }
  }

  async function runQuery(source: QuerySource, nextOffset = 0, mode: "replace" | "append" = "replace") {
    const previous = mode === "append" ? result() : null;
    const requestSerial = ++serial;
    abort?.abort();
    const controller = new AbortController();
    abort = controller;

    setEditor(null);
    setStatus({ tone: "busy", text: mode === "append" ? "loading more" : "running sql" });

    try {
      const nextResult = await request(
        {
          type: "query",
          connection: props.connection,
          source,
          limit: PAGE_SIZE,
          offset: nextOffset,
        },
        { signal: controller.signal, step: "run sql" },
      );
      if (requestSerial !== serial) return;

      const mergedResult =
        previous == null
          ? nextResult
          : {
              ...nextResult,
              offset: 0,
              rows: [...previous.rows, ...nextResult.rows],
              rowCount: nextResult.rowCount ?? previous.rowCount,
            };

      setSql(mergedResult.sql);
      setResult(mergedResult);
      if (mergedResult.source.kind === "relation") {
        setSelectedSchemaName(mergedResult.source.relation.schema);
      }
      reconcileRelationCount(mergedResult);
      setStatus({
        tone: "ok",
        text: `${mergedResult.rows.length} rows · ${nextResult.durationMs}ms`,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      setStatus({ tone: "warn", text: messageOf(error) });
    }
  }

  async function runSql() {
    const text = sql().trim();
    if (!text) {
      setStatus({ tone: "warn", text: "run sql: sql is empty" });
      return;
    }
    await runQuery({ kind: "sql", text });
  }

  async function loadMoreRows() {
    const current = result();
    if (current == null || !current.hasMore) return;
    await runQuery(current.source, current.rows.length, "append");
  }

  async function openRelation(relation: RelationRef) {
    setEditor(null);
    await runQuery({ kind: "relation", relation });
  }

  function clearQuery() {
    abort?.abort();
    serial += 1;
    setSql("");
    setResult(null);
    setEditor(null);
    setStatus({ tone: "idle", text: "ready" });
  }

  function editCell(row: Row, rowIndex: number, column: ResultColumn) {
    if (!canPatchCell(row, column)) {
      setEditor(null);
      return;
    }

    setEditor({ rowIndex, column: column.name });
  }

  async function submitCellEdit(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;

    const value = new FormData(form).get("value");
    await saveCell(typeof value === "string" ? value : "");
  }

  async function setNullCell() {
    await saveCell(null);
  }

  async function saveCell(value: ScalarValue) {
    const context = editorContext();
    if (context == null) return;
    const current = result();
    const origin = context.column.origin;
    const updateTarget = current?.updateTarget ?? null;
    if (
      current == null ||
      origin == null ||
      updateTarget == null ||
      !canPatchCell(context.row, context.column)
    ) {
      setStatus({ tone: "warn", text: `save ${context.column.name}: cell is read-only` });
      return;
    }

    const originalKey = keyForRow(context.row, updateTarget);
    const original = asScalar(context.row[context.column.name]);
    if (originalKey == null) {
      setStatus({ tone: "warn", text: `save ${context.column.name}: row has no editable primary key` });
      return;
    }

    if (original == null && value === "") {
      setEditor(null);
      setStatus({ tone: "idle", text: "unchanged" });
      return;
    }
    if (sameEditedValue(value, original)) {
      setEditor(null);
      setStatus({ tone: "idle", text: "unchanged" });
      return;
    }

    const update = { key: originalKey, changes: { [origin.column]: value } };
    setEditor(null);
    setStatus({ tone: "busy", text: `saving ${context.column.name}` });
    try {
      await request(
        {
          type: "update",
          connection: props.connection,
          relation: updateTarget.relation,
          updates: [update],
        },
        { step: `save ${context.column.name}` },
      );
      setStatus({ tone: "ok", text: "saved" });
      await runQuery(current.source);
    } catch (error) {
      setStatus({ tone: "warn", text: messageOf(error) });
    }
  }

  function cancelCellEdit() {
    setEditor(null);
  }

  function canPatchRow(row: Row) {
    const current = result();
    return current != null && current.columns.some((column) => canPatchColumn(row, column));
  }

  function canPatchCell(row: Row, column: ResultColumn) {
    return result() != null && canPatchColumn(row, column);
  }

  function canPatchColumn(row: Row, column: ResultColumn) {
    const target = result()?.updateTarget ?? null;
    return (
      target != null &&
      column.writable &&
      column.origin != null &&
      sameRelation(column.origin.relation, target.relation) &&
      !isPreviewCell(row[column.name]) &&
      keyForRow(row, target) != null
    );
  }

  function insertSqlNewline(input: HTMLTextAreaElement) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const next = `${sql().slice(0, start)}\n${sql().slice(end)}`;
    setSql(next);
    requestAnimationFrame(() => {
      input.selectionStart = start + 1;
      input.selectionEnd = start + 1;
    });
  }

  function insertEditNewline(input: HTMLTextAreaElement) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.value = `${input.value.slice(0, start)}\n${input.value.slice(end)}`;
    input.selectionStart = start + 1;
    input.selectionEnd = start + 1;
  }

  async function disconnect() {
    if (!disconnectArmed()) {
      setDisconnectArmed(true);
      if (disconnectTimer != null) clearTimeout(disconnectTimer);
      disconnectTimer = setTimeout(() => setDisconnectArmed(false), 2600);
      return;
    }

    abort?.abort();
    serial += 1;
    setDisconnectArmed(false);
    setStatus({ tone: "busy", text: "disconnecting" });
    try {
      await request({ type: "disconnect", connection: props.connection }, { step: "disconnect" });
      props.onDisconnect();
    } catch (error) {
      setStatus({ tone: "warn", text: messageOf(error) });
    }
  }

  function reconcileRelationCount(nextResult: QueryResult) {
    const source = nextResult.source;
    const rowCount = nextResult.rowCount;
    if (source.kind !== "relation" || rowCount == null || rowCount.kind !== "exact") return;
    const relation = source.relation;

    setCatalog((current) => {
      if (current == null) return current;
      return {
        ...current,
        relations: current.relations.map((item) =>
          item.schema === relation.schema && item.name === relation.name ? { ...item, rowCount } : item,
        ),
      };
    });
  }

  return (
    <main class="shell">
      <aside class="sidebar">
        <div class="connection">
          <span>database</span>
          <strong title={connectionLabel(props.connection)}>
            {catalog()?.database ?? connectionLabel(props.connection)}
          </strong>
          <button
            type="button"
            classList={{ "disconnect-button": true, "is-confirming": disconnectArmed() }}
            title="Disconnect"
            onClick={() => void disconnect()}
          >
            {disconnectArmed() ? "confirm" : "×"}
          </button>
        </div>

        <label class="schema-select">
          <span>schema</span>
          <select value={selectedSchema()} onChange={(event) => setSelectedSchemaName(event.currentTarget.value)}>
            <For each={schemas()}>{(name) => <option value={name}>{name}</option>}</For>
          </select>
        </label>

        <input
          class="relation-filter"
          value={relationFilter()}
          onInput={(event) => setRelationFilter(event.currentTarget.value)}
          placeholder="filter relations"
        />

        <button
          type="button"
          classList={{ "relation-button": true, "is-active": selectedRelation() == null }}
          onClick={clearQuery}
        >
          <span class="relation-dot" aria-hidden="true" />
          <span>query</span>
        </button>

        <nav class="relation-list" aria-label="Relations">
          <For each={filteredRelations()}>
            {(relation) => {
              const active = createMemo(
                () => selectedRelation()?.schema === relation.schema && selectedRelation()?.name === relation.name,
              );
              return (
                <button
                  type="button"
                  classList={{ "relation-button": true, "is-active": active() }}
                  onClick={() => void openRelation(relation)}
                  aria-current={active() ? "page" : undefined}
                >
                  <span class="relation-dot" aria-hidden="true" />
                  <span>{relation.name}</span>
                  <small>{relationCountLabel(relation.rowCount)}</small>
                </button>
              );
            }}
          </For>
        </nav>

        <button type="button" class="refresh-button" onClick={() => void loadCatalog()}>
          refresh
        </button>
      </aside>

      <section class="workspace">
        <form
          class="sqlbar"
          onSubmit={(event) => {
            event.preventDefault();
            void runSql();
          }}
        >
          <span class="prompt">{prompt()}</span>
          <textarea
            value={sql()}
            rows={sql().includes("\n") ? 3 : 1}
            spellcheck={false}
            onInput={(event) => setSql(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey || event.shiftKey)) {
                event.preventDefault();
                insertSqlNewline(event.currentTarget);
              } else if (event.key === "Enter") {
                event.preventDefault();
                void runSql();
              }
            }}
          />
          <button type="submit">run</button>
        </form>

        <div class="query-status">
          <StatusMessage status={status()} />
        </div>

        <div class="grid">
          <div classList={{ "loading-line": true, "is-busy": status().tone === "busy" }} />
          <div class="grid-scroll">
            <Show
              when={(result()?.columns.length ?? 0) > 0}
              fallback={<div class="empty-state">{result() == null ? "run sql to inspect rows." : "no columns."}</div>}
            >
              <table class="data-grid">
                <thead>
                  <tr>
                    <th class="row-number" />
                    <For each={result()?.columns ?? []}>
                      {(column) => (
                        <th>
                          <span>{column.name}</span>
                          <small>
                            {result()?.updateTarget?.keyColumns.some(
                              (keyColumn) => keyColumn.resultColumn === column.name,
                            )
                              ? `${column.sqlType} pk`
                              : column.sqlType}
                          </small>
                        </th>
                      )}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <Show
                    when={(result()?.rows.length ?? 0) > 0}
                    fallback={
                      <tr>
                        <td class="empty-cell" colSpan={(result()?.columns.length ?? 0) + 1}>
                          no rows
                        </td>
                      </tr>
                    }
                  >
                    <For each={result()?.rows ?? []}>
                      {(row, rowIndex) => (
                        <tr classList={{ "is-readonly": !canPatchRow(row) }}>
                          <td class="row-number">{rowIndex() + 1}</td>
                          <For each={result()?.columns ?? []}>
                            {(column) => {
                              const value = createMemo(() => row[column.name]);
                              const active = createMemo(
                                () => editor()?.rowIndex === rowIndex() && editor()?.column === column.name,
                              );
                              return (
                                <td
                                  classList={{
                                    "is-active": active(),
                                    "is-null": value() == null,
                                    "is-readonly": !canPatchCell(row, column),
                                  }}
                                  data-kind={cellKind(value(), column)}
                                  title={valueTitle(value(), column)}
                                  on:click={(event) => {
                                    stopBodyClick(event);
                                    editCell(row, rowIndex(), column);
                                  }}
                                >
                                  <CellValueView value={value()} column={column} />
                                </td>
                              );
                            }}
                          </For>
                        </tr>
                      )}
                    </For>
                  </Show>
                </tbody>
                <tfoot>
                  <tr
                    classList={{ "more-row": true, "is-action": result()?.hasMore === true }}
                    onClick={() => {
                      if (result()?.hasMore === true && status().tone !== "busy") {
                        void loadMoreRows();
                      }
                    }}
                  >
                    <td colSpan={(result()?.columns.length ?? 0) + 1}>
                      <Show when={result()?.hasMore === true}>
                        <button
                          type="button"
                          class="more-button"
                          disabled={status().tone === "busy"}
                          tabIndex={-1}
                        >
                          more
                        </button>
                      </Show>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </Show>
          </div>
        </div>

        <Show when={editorContext()} keyed>
          {(context) => (
            <form class="cell-editor" on:click={stopBodyClick} onSubmit={(event) => void submitCellEdit(event)}>
              <div class="edit-label">
                <strong>{rowIdentityLabel(context.row, result()?.updateTarget ?? null)}</strong>
                <span>{context.column.name} =</span>
              </div>
              <textarea
                ref={editInput}
                name="value"
                value={editorDraft(context.row[context.column.name])}
                placeholder={context.row[context.column.name] == null ? "NULL" : undefined}
                spellcheck={false}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  if (event.metaKey || event.ctrlKey || event.shiftKey) {
                    insertEditNewline(event.currentTarget);
                  } else {
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div class="edit-actions">
                <Show when={context.column.nullable}>
                  <button type="button" on:click={() => void setNullCell()}>
                    set null
                  </button>
                </Show>
                <button type="button" on:click={cancelCellEdit}>
                  cancel
                </button>
                <button type="submit" class="primary-button">
                  apply
                </button>
              </div>
            </form>
          )}
        </Show>
      </section>
    </main>
  );
}

async function request<R extends DbRequest>(
  body: R,
  options: { signal?: AbortSignal; step: string },
): Promise<DbResult<R>> {
  let response: Response;
  try {
    response = await fetch("/api/db", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new Error(stepMessage(options.step, messageOf(error)));
  }

  let payload: DbResponse<DbResult<R>>;
  try {
    payload = (await response.json()) as DbResponse<DbResult<R>>;
  } catch {
    throw new Error(stepMessage(options.step, `server returned ${response.status} without error details`));
  }

  if (!payload.ok) throw new Error(stepMessage(options.step, payload.error));
  return payload.result;
}

function CellValueView(props: { value: CellValue; column: ResultColumn }) {
  if (props.value == null) return <span class="null-token">NULL</span>;

  const bytea = byteaDisplay(props.value, props.column);
  if (bytea != null) {
    if (bytea.bytes != null && bytea.bytes > BYTEA_INLINE_BYTES) {
      return <span class="byte-size-token">{formatBytes(bytea.bytes)}</span>;
    }
    return <span class="bytea-inline">{bytea.text}</span>;
  }

  if (isUuidValue(props.value, props.column)) {
    return (
      <span class="uuid-cell" aria-label={props.value}>
        <For each={uuidStripeColors(props.value)}>{(color) => <span style={{ color }}>●</span>}</For>
      </span>
    );
  }

  if (typeof props.value === "boolean") {
    return <span classList={{ "bool-token": true, "is-true": props.value }}>{String(props.value)}</span>;
  }

  return <span>{cellDisplay(props.value)}</span>;
}

function cellDisplay(value: CellValue) {
  if (isPreviewCell(value) && value.format === "bytes" && value.bytes != null) return formatBytes(value.bytes);
  return cellText(value);
}

function cellText(value: CellValue) {
  if (value == null) return "NULL";
  if (isPreviewCell(value)) return `${value.text}${value.truncated ? "..." : ""}`;
  return String(value);
}

function editorDraft(value: CellValue) {
  return value == null ? "" : cellText(value);
}

function valueTitle(value: CellValue, column?: ResultColumn): string {
  if (value == null) return "NULL";
  if (column != null && isUuidValue(value, column)) return value;
  if (isPreviewCell(value) && value.format === "bytes" && value.bytes != null) return `${formatBytes(value.bytes)} ${value.text}`;
  return cellText(value);
}

function asScalar(value: CellValue): ScalarValue {
  if (isPreviewCell(value)) return null;
  return value;
}

function sameEditedValue(value: ScalarValue, original: ScalarValue) {
  if (value == null) return original == null;
  return String(value) === cellText(original);
}

function keyForRow(row: Row, target: UpdateTarget) {
  const key: Record<string, ScalarValue> = {};
  for (const column of target.keyColumns) {
    const value = asScalar(row[column.resultColumn]);
    if (value == null) return null;
    key[column.relationColumn] = value;
  }
  return key;
}

function rowIdentityLabel(row: Row, target: UpdateTarget | null) {
  const key = target == null ? null : keyForRow(row, target);
  if (key == null) return "synthetic row";
  return Object.entries(key)
    .map(([key, value]) => `${key} = ${cellText(value)}`)
    .join(" / ");
}

function isUuidValue(value: CellValue, column: ResultColumn): value is string {
  return column.valueKind === "uuid" && typeof value === "string";
}

function byteaDisplay(value: CellValue, column: ResultColumn) {
  if (isPreviewCell(value) && value.format === "bytes") {
    return { text: cellText(value), bytes: value.bytes ?? null };
  }
  if (column.valueKind !== "bytes" || typeof value !== "string") return null;
  return { text: value, bytes: byteaByteLength(value) };
}

function byteaByteLength(value: string) {
  const hex = value.startsWith("\\x") || value.startsWith("\\X") ? value.slice(2) : value;
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) return null;
  return hex.length / 2;
}

function relationSearchText(relation: RelationRef) {
  return `${relation.schema}.${relation.name} ${relation.name}`.toLowerCase();
}

function relationCountLabel(rowCount: RowCount) {
  if (rowCount == null) return "";
  if (rowCount.kind === "estimate" && rowCount.value === 0) return "";
  return rowCount.kind === "estimate" ? `~${rowCount.value}` : String(rowCount.value);
}

function cellKind(value: CellValue, column: ResultColumn) {
  if (value == null) return "null";
  if (isPreviewCell(value)) return value.format;
  return column.valueKind;
}

function uuidStripeColors(value: string) {
  const hex = value.replaceAll("-", "").toLowerCase();
  return [0x243f6a88, 0x85a308d3, 0x13198a2e, 0x9e3779b9].map((seed) => {
    const hash = hashUuid(hex, seed);
    const hue = hash % 360;
    const saturation = 58 + ((hash >>> 9) % 30);
    const lightness = 38 + ((hash >>> 17) % 24);
    return `hsl(${hue} ${saturation}% ${lightness}%)`;
  });
}

function hashUuid(value: string, seed: number) {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x45d9f3b);
    hash = (hash << 13) | (hash >>> 19);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${formatAmount(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${formatAmount(bytes / 1024 / 1024)}MB`;
  return `${formatAmount(bytes / 1024 / 1024 / 1024)}GB`;
}

function formatAmount(value: number) {
  return value >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
}

function connectionLabel(value: string) {
  try {
    const url = new URL(value);
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return value;
  }
}

function StatusMessage(props: { status: Status }) {
  return (
    <span class={`status-${props.status.tone}`} title={props.status.text} role="status" aria-live="polite">
      {props.status.text}
    </span>
  );
}

function expandConnectionShortcut(value: string) {
  const text = value.trim();
  if (isPostgresIdentifier(text)) {
    return `postgres://localhost/${encodeURIComponent(text)}`;
  }
  return text;
}

function isPostgresIdentifier(value: string) {
  return POSTGRES_IDENTIFIER.test(value) && new TextEncoder().encode(value).length <= POSTGRES_IDENTIFIER_LIMIT;
}

function stepMessage(step: string, message: string) {
  return message.toLowerCase().startsWith(`${step.toLowerCase()}:`) ? message : `${step}: ${message}`;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "unknown error";
}
