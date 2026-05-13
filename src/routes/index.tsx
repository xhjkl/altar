import { Title } from "@solidjs/meta";
import { createContext, createMemo, createSignal, For, onCleanup, onMount, Show, useContext } from "solid-js";
import type { Accessor } from "solid-js";
import type {
  Catalog,
  CellValue,
  ColumnInfo,
  DbRequest,
  DbResponse,
  PatchResult,
  PreviewCell,
  RelationInfo,
  RelationRef,
  ResultSet,
  RowCount,
  RowPatch,
  ScalarValue,
} from "~/lib/protocol";

type Status =
  | { tone: "idle"; text: string }
  | { tone: "busy"; text: string }
  | { tone: "ok"; text: string }
  | { tone: "warn"; text: string };

type Editor = {
  rowIndex: number;
  column: string;
};

const PAGE_SIZE = 50;
const CONNECTION_KEY = "altar:connection";
const POSTGRES_IDENTIFIER_LIMIT = 63;
const POSTGRES_IDENTIFIER = /^[\p{L}_][\p{L}_0-9$]*$/u;
const BYTEA_INLINE_BYTES = 24;

type ConnectionStore = {
  connection: Accessor<string | null>;
  connect: (connection: string) => void;
  disconnect: () => void;
};

const ConnectionContext = createContext<ConnectionStore>();

export default function Altar() {
  const [connection, setConnection] = createSignal<string | null>(null);

  onMount(() => {
    setConnection(window.sessionStorage.getItem(CONNECTION_KEY));
  });

  const store: ConnectionStore = {
    connection,
    connect(nextConnection) {
      window.sessionStorage.setItem(CONNECTION_KEY, nextConnection);
      setConnection(nextConnection);
    },
    disconnect() {
      window.sessionStorage.removeItem(CONNECTION_KEY);
      setConnection(null);
    },
  };

  return (
    <ConnectionContext.Provider value={store}>
      <Title>Altar</Title>
      <Show when={connection()} keyed fallback={<ConnectScreen />}>
        {() => <Studio />}
      </Show>
    </ConnectionContext.Provider>
  );
}

function ConnectScreen() {
  const store = useConnection();
  const [draft, setDraft] = createSignal("");
  const [status, setStatus] = createSignal<Status>({ tone: "idle", text: "" });
  let input: HTMLInputElement | undefined;

  async function connect(event: SubmitEvent) {
    event.preventDefault();
    const rawConnection = (input?.value ?? draft()).trim();
    const nextConnection = expandConnectionShortcut(rawConnection);
    if (!nextConnection) {
      setStatus({ tone: "warn", text: "enter a connection string." });
      return;
    }

    setStatus({ tone: "busy", text: "connecting" });
    try {
      const catalog = await request<Catalog>({ type: "catalog", connection: nextConnection }, { step: "connect" });
      if (catalog.database == null) {
        throw new Error(stepMessage("connect", catalog.notice ?? "could not reach postgres."));
      }
      store.connect(nextConnection);
    } catch (error) {
      setStatus({ tone: "warn", text: friendlyConnectError(error) });
    }
  }

  return (
    <main class="connect-screen">
      <section class="connect-panel" aria-label="postgres connection">
        <form class="connect-card" onSubmit={connect}>
          <label class="connect-field">
            <input
              value={draft()}
              ref={input}
              aria-label="connection string"
              placeholder="postgres://user@host/db"
              spellcheck={false}
              autocomplete="off"
              autofocus
              onInput={(event) => setDraft(event.currentTarget.value)}
            />
          </label>
          <div class="connect-actions">
            <Show when={status()} keyed>{(current) => <StatusMessage status={current} />}</Show>
            <button type="submit" class="primary-button" disabled={status().tone === "busy"}>
              connect
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

function Studio() {
  const store = useConnection();
  const [catalog, setCatalog] = createSignal<Catalog | null>(null);
  const [sql, setSql] = createSignal("");
  const [result, setResult] = createSignal<ResultSet | null>(null);
  const [canLoadMore, setCanLoadMore] = createSignal(false);
  const [status, setStatus] = createSignal<Status>({ tone: "busy", text: "connecting" });
  const [editor, setEditor] = createSignal<Editor | null>(null);
  const [relationFilter, setRelationFilter] = createSignal("");
  const [selectedSchemaName, setSelectedSchemaName] = createSignal<string | null>(null);
  const [patchTarget, setPatchTarget] = createSignal<RelationRef | null>(null);
  const [disconnectArmed, setDisconnectArmed] = createSignal(false);

  let abort: AbortController | null = null;
  let serial = 0;
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
  const selectedRelation = createMemo(() => patchTarget() ?? result()?.patchTarget ?? null);
  const prompt = createMemo(() => {
    const relation = patchTarget();
    return relation == null ? `${selectedSchema()}=>` : `${relation.schema}.${relation.name}=>`;
  });
  const editorContext = createMemo(() => {
    const current = result();
    const currentEditor = editor();
    if (current == null || currentEditor == null) return null;

    const row = current.records[currentEditor.rowIndex] ?? null;
    const column = current.columns.find((item) => item.name === currentEditor.column) ?? null;
    if (row == null || column == null || !canPatchCell(row, column)) return null;

    return { row, rowIndex: currentEditor.rowIndex, column };
  });

  async function loadCatalog() {
    setStatus({ tone: "busy", text: "loading catalog" });
    try {
      const nextCatalog = await request<Catalog>({ type: "catalog", connection: connection() }, { step: "load catalog" });
      const notice =
        nextCatalog.database == null && nextCatalog.notice != null
          ? stepMessage("load catalog", nextCatalog.notice)
          : (nextCatalog.notice ?? `${nextCatalog.relations.length} relations`);
      setCatalog(nextCatalog);
      setStatus({
        tone: nextCatalog.relations.length === 0 ? "warn" : "ok",
        text: notice,
      });
    } catch (error) {
      setStatus({ tone: "warn", text: messageOf(error) });
    }
  }

  async function runSql(nextOffset = 0, hint = patchTarget(), sqlOverride = sql(), mode: "replace" | "append" = "replace") {
    const text = sqlOverride.trim();
    if (!text) {
      setStatus({ tone: "warn", text: "run sql: sql is empty" });
      return;
    }

    const previous = mode === "append" ? result() : null;
    const requestSerial = ++serial;
    abort?.abort();
    const controller = new AbortController();
    abort = controller;

    setEditor(null);
    setStatus({ tone: "busy", text: mode === "append" ? "loading more" : "running sql" });

    try {
      const nextResult = await request<ResultSet>(
        {
          type: "query",
          connection: connection(),
          sql: text,
          limit: PAGE_SIZE,
          offset: nextOffset,
          patchTarget: hint,
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
              records: [...previous.records, ...nextResult.records],
              totalRows: nextResult.totalRows ?? previous.totalRows,
            };

      setSql(mergedResult.sql);
      setResult(mergedResult);
      setPatchTarget(mergedResult.patchTarget);
      setCanLoadMore(resultCanLoadMore(nextResult, nextOffset));
      if (mergedResult.patchTarget != null) setSelectedSchemaName(mergedResult.patchTarget.schema);
      reconcileRelationCount(mergedResult);
      setStatus({
        tone: "ok",
        text: nextResult.notice ?? `${mergedResult.records.length} rows · ${nextResult.durationMs}ms`,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      setStatus({ tone: "warn", text: messageOf(error) });
    }
  }

  async function loadMoreRows() {
    const current = result();
    if (current == null || !canLoadMore()) return;
    await runSql(current.records.length, current.patchTarget, current.sql, "append");
  }

  async function openRelation(relation: RelationRef) {
    const nextSql = tableSelectSql(relation);
    setSql(nextSql);
    setPatchTarget(relation);
    setEditor(null);
    await runSql(0, relation, nextSql);
  }

  function clearQuery() {
    abort?.abort();
    serial += 1;
    setSql("");
    setResult(null);
    setCanLoadMore(false);
    setEditor(null);
    setPatchTarget(null);
    setStatus({ tone: "idle", text: "ready" });
  }

  function editCell(row: Record<string, CellValue>, rowIndex: number, column: ColumnInfo) {
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
    const source = context.column.source;
    if (current == null || source == null || !canPatchCell(context.row, context.column)) {
      setStatus({ tone: "warn", text: `save ${context.column.name}: cell is read-only` });
      return;
    }

    const originalPk = primaryKeyForColumn(context.row, context.column, current.columns);
    const original = asScalar(context.row[context.column.name]);
    if (originalPk == null) {
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

    const patch: RowPatch = { where: originalPk, set: { [source.column]: value } };
    setEditor(null);
    setStatus({ tone: "busy", text: `saving ${context.column.name}` });
    try {
      await request<PatchResult>(
        {
          type: "patch",
          connection: connection(),
          relation: source.relation,
          patches: [patch],
        },
        { step: `save ${context.column.name}` },
      );
      setStatus({ tone: "ok", text: "saved" });
      await runSql(0, current.patchTarget, current.sql);
    } catch (error) {
      setStatus({ tone: "warn", text: messageOf(error) });
    }
  }

  function cancelCellEdit() {
    setEditor(null);
  }

  function cellValue(row: Record<string, CellValue>, column: ColumnInfo) {
    return row[column.name];
  }

  function canPatchRow(row: Record<string, CellValue>) {
    const current = result();
    return current != null && current.columns.some((column) => canPatchColumn(row, column, current.columns));
  }

  function canPatchCell(row: Record<string, CellValue>, column: ColumnInfo) {
    const current = result();
    return current != null && canPatchColumn(row, column, current.columns);
  }

  function canPatchColumn(row: Record<string, CellValue>, column: ColumnInfo, columns: ColumnInfo[]) {
    return column.patchable && !isPreviewCell(row[column.name]) && primaryKeyForColumn(row, column, columns) != null;
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

  function connection() {
    const value = store.connection();
    if (value == null) throw new Error("Missing connection");
    return value;
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
      await request<{ disconnected: boolean }>({ type: "disconnect", connection: connection() }, { step: "disconnect" });
      store.disconnect();
    } catch (error) {
      setStatus({ tone: "warn", text: messageOf(error) });
    }
  }

  function reconcileRelationCount(nextResult: ResultSet) {
    const relation = nextResult.patchTarget;
    const rowCount = nextResult.totalRows;
    if (relation == null || rowCount == null || rowCount.kind !== "exact") return;

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
          <strong title={connectionLabel(connection())}>{catalog()?.database ?? connectionLabel(connection())}</strong>
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
                  <span>{relationDisplayName(relation)}</span>
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
          <Show when={status()} keyed>{(current) => <StatusMessage status={current} />}</Show>
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
                          <small>{column.primaryKey ? `${column.typeLabel} pk` : column.typeLabel}</small>
                        </th>
                      )}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <Show
                    when={(result()?.records.length ?? 0) > 0}
                    fallback={
                      <tr>
                        <td class="empty-cell" colSpan={(result()?.columns.length ?? 0) + 1}>
                          no rows
                        </td>
                      </tr>
                    }
                  >
                    <For each={result()?.records ?? []}>
                      {(row, rowIndex) => (
                        <tr classList={{ "is-readonly": !canPatchRow(row) }}>
                          <td class="row-number">{rowIndex() + 1}</td>
                          <For each={result()?.columns ?? []}>
                            {(column) => {
                              const value = createMemo(() => cellValue(row, column));
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
                                  onClick={() => editCell(row, rowIndex(), column)}
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
                    classList={{ "more-row": true, "is-action": canLoadMore() }}
                    onClick={() => {
                      if (canLoadMore() && status().tone !== "busy") void loadMoreRows();
                    }}
                  >
                    <td colSpan={(result()?.columns.length ?? 0) + 1}>
                      <Show when={canLoadMore()}>
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
            <form class="cell-editor" onSubmit={(event) => void submitCellEdit(event)}>
              <div class="edit-label">
                <strong>{rowIdentityLabel(context.row, result()?.columns ?? [], context.column)}</strong>
                <span>{context.column.name} =</span>
              </div>
              <textarea
                name="value"
                value={editorDraft(cellValue(context.row, context.column))}
                placeholder={context.row[context.column.name] == null ? "NULL" : undefined}
                spellcheck={false}
                autofocus
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
                  <button type="button" onClick={() => void setNullCell()}>
                    set null
                  </button>
                </Show>
                <button type="button" onClick={cancelCellEdit}>
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

async function request<T>(
  body: DbRequest,
  options: { signal?: AbortSignal; step: string },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new Error(stepMessage(options.step, messageOf(error)));
  }

  let payload: DbResponse<T>;
  try {
    payload = (await response.json()) as DbResponse<T>;
  } catch {
    throw new Error(stepMessage(options.step, `server returned ${response.status} without error details`));
  }

  if (!payload.ok) throw new Error(stepMessage(options.step, payload.error));
  return payload.result;
}

function CellValueView(props: { value: CellValue | ScalarValue; column: ColumnInfo }) {
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

function cellDisplay(value: CellValue | ScalarValue) {
  if (isPreviewCell(value) && value.format === "bytes" && value.bytes != null) return formatBytes(value.bytes);
  return cellText(value);
}

function cellText(value: CellValue | ScalarValue) {
  if (value == null) return "NULL";
  if (isPreviewCell(value)) return `${value.text}${value.truncated ? "..." : ""}`;
  return String(value);
}

function editorDraft(value: CellValue) {
  return value == null ? "" : cellText(value);
}

function valueTitle(value: CellValue | ScalarValue, column?: ColumnInfo) {
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

function primaryKeyForColumn(row: Record<string, CellValue>, column: ColumnInfo, columns: ColumnInfo[]) {
  const source = column.source;
  if (source == null) return null;

  const primaryColumns = columns.filter(
    (item) => item.primaryKey && item.source != null && sameRelation(item.source.relation, source.relation),
  );
  if (primaryColumns.length === 0) return null;

  const primaryKey: Record<string, ScalarValue> = {};
  for (const column of primaryColumns) {
    const source = column.source;
    if (source == null) return null;
    const value = asScalar(row[column.name]);
    if (value == null) return null;
    primaryKey[source.column] = value;
  }
  return primaryKey;
}

function rowIdentityLabel(row: Record<string, CellValue>, columns: ColumnInfo[], column: ColumnInfo) {
  const primaryKey = primaryKeyForColumn(row, column, columns);
  if (primaryKey == null) return "synthetic row";
  return Object.entries(primaryKey)
    .map(([key, value]) => `${key} = ${cellText(value)}`)
    .join(" / ");
}

function sameRelation(left: RelationRef, right: RelationRef) {
  return left.schema === right.schema && left.name === right.name;
}

function isPreviewCell(value: CellValue | ScalarValue): value is PreviewCell {
  return typeof value === "object" && value != null && "kind" in value;
}

function isUuidValue(value: CellValue | ScalarValue, column: ColumnInfo) {
  return column.kind === "uuid" && typeof value === "string";
}

function byteaDisplay(value: CellValue | ScalarValue, column: ColumnInfo) {
  if (isPreviewCell(value) && value.format === "bytes") {
    return { text: cellText(value), bytes: value.bytes ?? null };
  }
  if (column.kind !== "bytes" || typeof value !== "string") return null;
  return { text: value, bytes: byteaByteLength(value) };
}

function byteaByteLength(value: string) {
  const hex = value.startsWith("\\x") || value.startsWith("\\X") ? value.slice(2) : value;
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) return null;
  return hex.length / 2;
}

function tableSelectSql(relation: RelationRef) {
  return `select * from ${quotePath(relation.schema, relation.name)}`;
}

function relationDisplayName(relation: RelationRef | RelationInfo) {
  return relation.name;
}

function relationSearchText(relation: RelationRef | RelationInfo) {
  return `${relation.schema}.${relation.name} ${relation.name}`.toLowerCase();
}

function relationCountLabel(rowCount: RowCount) {
  if (rowCount == null) return "";
  if (rowCount.kind === "estimate" && rowCount.value === 0) return "";
  return rowCount.kind === "estimate" ? `~${rowCount.value}` : String(rowCount.value);
}

function resultCanLoadMore(result: ResultSet, offset: number) {
  if (result.records.length < result.limit) return false;
  if (result.totalRows == null || result.totalRows.kind === "estimate") return true;
  return offset + result.records.length < result.totalRows.value;
}

function cellKind(value: CellValue | ScalarValue, column: ColumnInfo) {
  if (value == null) return "null";
  if (isPreviewCell(value)) return value.format;
  return column.kind;
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

function quoteIdent(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quotePath(schema: string, table: string) {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
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

function useConnection() {
  const store = useContext(ConnectionContext);
  if (store == null) throw new Error("Connection context is missing");
  return store;
}

function friendlyConnectError(error: unknown) {
  return messageOf(error);
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
