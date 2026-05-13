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
  draft: string;
};

const PAGE_SIZE = 50;
const CONNECTION_KEY = "altar:connection";

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
    const nextConnection = (input?.value ?? draft()).trim();
    if (!nextConnection) {
      setStatus({ tone: "warn", text: "Enter a Postgres URL." });
      return;
    }

    setStatus({ tone: "busy", text: "Connecting..." });
    try {
      const catalog = await request<Catalog>({ type: "catalog", connection: nextConnection });
      if (catalog.database == null) throw new Error(catalog.notice ?? "Could not reach Postgres.");
      store.connect(nextConnection);
    } catch (error) {
      setStatus({ tone: "warn", text: friendlyConnectError(error) });
    }
  }

  return (
    <main class="connect-screen">
      <form class="connect-card" onSubmit={connect}>
        <input
          value={draft()}
          ref={input}
          aria-label="Postgres connection URL"
          placeholder="postgres://user:password@localhost:5432/database"
          spellcheck={false}
          autofocus
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <div class="connect-actions">
          <span class={`status-${status().tone}`}>{status().text}</span>
          <button type="submit" class="primary-button" disabled={status().tone === "busy"}>
            Connect
          </button>
        </div>
      </form>
    </main>
  );
}

function Studio() {
  const store = useConnection();
  const [catalog, setCatalog] = createSignal<Catalog | null>(null);
  const [sql, setSql] = createSignal("");
  const [result, setResult] = createSignal<ResultSet | null>(null);
  const [pageOffset, setPageOffset] = createSignal(0);
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
  const canPrev = createMemo(() => pageOffset() > 0);
  const canNext = createMemo(() => {
    const current = result();
    if (current == null) return false;
    if (current.totalRows == null || current.totalRows.kind === "estimate") return current.records.length === PAGE_SIZE;
    return pageOffset() + PAGE_SIZE < current.totalRows.value;
  });
  const editorContext = createMemo(() => {
    const current = result();
    const currentEditor = editor();
    if (current == null || currentEditor == null) return null;

    const row = current.records[currentEditor.rowIndex] ?? null;
    const column = current.columns.find((item) => item.name === currentEditor.column) ?? null;
    if (row == null || column == null || !canPatchCell(row, column)) return null;

    return { row, rowIndex: currentEditor.rowIndex, column, draft: currentEditor.draft };
  });

  async function loadCatalog() {
    setStatus({ tone: "busy", text: "connecting" });
    try {
      const nextCatalog = await request<Catalog>({ type: "catalog", connection: connection() });
      setCatalog(nextCatalog);
      setStatus({
        tone: nextCatalog.relations.length === 0 ? "warn" : "ok",
        text: nextCatalog.notice ?? `${nextCatalog.relations.length} relations`,
      });
    } catch (error) {
      setStatus({ tone: "warn", text: messageOf(error) });
    }
  }

  async function runSql(nextOffset = 0, hint = patchTarget(), sqlOverride = sql()) {
    const text = sqlOverride.trim();
    if (!text) return;

    const requestSerial = ++serial;
    abort?.abort();
    const controller = new AbortController();
    abort = controller;

    setPageOffset(nextOffset);
    setEditor(null);
    setStatus({ tone: "busy", text: "running SQL" });

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
        controller.signal,
      );
      if (requestSerial !== serial) return;

      setSql(nextResult.sql);
      setResult(nextResult);
      setPatchTarget(nextResult.patchTarget);
      if (nextResult.patchTarget != null) setSelectedSchemaName(nextResult.patchTarget.schema);
      reconcileRelationCount(nextResult);
      setStatus({
        tone: "ok",
        text: nextResult.notice ?? `${nextResult.records.length} rows in ${nextResult.durationMs}ms`,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      setStatus({ tone: "warn", text: messageOf(error) });
    }
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
    setPageOffset(0);
    setEditor(null);
    setPatchTarget(null);
    setStatus({ tone: "idle", text: "ready" });
  }

  function editCell(row: Record<string, CellValue>, rowIndex: number, column: ColumnInfo) {
    if (!canPatchCell(row, column)) {
      setEditor(null);
      return;
    }

    setEditor({ rowIndex, column: column.name, draft: editorDraft(cellValue(row, column)) });
  }

  async function saveCellEdit() {
    const context = editorContext();
    if (context == null) return;
    await saveCell(context.draft);
  }

  async function setNullCell() {
    await saveCell(null);
  }

  async function saveCell(value: ScalarValue) {
    const context = editorContext();
    if (context == null) return;
    const current = result();
    if (current?.patchTarget == null || !canPatchCell(context.row, context.column)) return;

    const originalPk = primaryKeyForRow(context.row, current.columns);
    const original = asScalar(context.row[context.column.name]);
    if (originalPk == null || original === undefined) return;

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

    const patch: RowPatch = { where: originalPk, set: { [context.column.name]: value } };
    setEditor(null);
    setStatus({ tone: "busy", text: `saving ${context.column.name}` });
    try {
      await request<PatchResult>({
        type: "patch",
        connection: connection(),
        relation: current.patchTarget,
        patches: [patch],
      });
      setStatus({ tone: "ok", text: "saved" });
      await runSql(pageOffset(), current.patchTarget, current.sql);
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
    return current?.patchTarget != null && primaryKeyForRow(row, current.columns) != null;
  }

  function canPatchCell(row: Record<string, CellValue>, column: ColumnInfo) {
    return canPatchRow(row) && column.patchable && !isPreviewCell(row[column.name]);
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
    await request<{ disconnected: boolean }>({ type: "disconnect", connection: connection() }).catch(() => null);
    store.disconnect();
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
          <span>connected to</span>
          <strong title={connection()}>{catalog()?.database ?? connectionLabel(connection())}</strong>
          <button
            type="button"
            classList={{ "disconnect-button": true, "is-confirming": disconnectArmed() }}
            title="Disconnect"
            onClick={() => void disconnect()}
          >
            {disconnectArmed() ? "Confirm" : "×"}
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
          <span class="relation-kind">q</span>
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
                >
                  <span class="relation-kind">{relation.kind === "view" ? "v" : "t"}</span>
                  <span>{relationDisplayName(relation)}</span>
                  <small>{relationCountLabel(relation.rowCount)}</small>
                </button>
              );
            }}
          </For>
        </nav>

        <button type="button" class="refresh-button" onClick={() => void loadCatalog()}>
          refresh catalog
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
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                insertSqlNewline(event.currentTarget);
              } else if (event.key === "Enter") {
                event.preventDefault();
                void runSql();
              }
            }}
          />
          <button type="submit">Run</button>
        </form>

        <div class="grid">
          <div classList={{ "loading-line": true, "is-busy": status().tone === "busy" }} />
          <div class="grid-scroll">
            <Show
              when={(result()?.columns.length ?? 0) > 0}
              fallback={<div class="empty-state">{result() == null ? "Run SQL to inspect rows." : "No columns."}</div>}
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
                          No rows
                        </td>
                      </tr>
                    }
                  >
                    <For each={result()?.records ?? []}>
                      {(row, rowIndex) => (
                        <tr classList={{ "is-readonly": !canPatchRow(row) }}>
                          <td class="row-number">{pageOffset() + rowIndex() + 1}</td>
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
              </table>
            </Show>
          </div>
        </div>

        <Show when={editorContext()} keyed>
          {(context) => (
            <div class="cell-editor">
              <div class="edit-label">
                <strong>{rowIdentityLabel(context.row, result()?.columns ?? [])}</strong>
                <span>{context.column.name} =</span>
              </div>
              <textarea
                value={context.draft}
                placeholder={context.row[context.column.name] == null ? "NULL" : undefined}
                spellcheck={false}
                ref={(input) => {
                  requestAnimationFrame(() => {
                    input.focus();
                    input.select();
                  });
                }}
                onInput={(event) =>
                  setEditor((current) =>
                    current == null ? current : { ...current, draft: event.currentTarget.value },
                  )
                }
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void saveCellEdit();
                  if (event.key === "Escape") cancelCellEdit();
                }}
              />
              <div class="edit-actions">
                <Show when={context.column.nullable}>
                  <button type="button" onClick={() => void setNullCell()}>
                    Set NULL
                  </button>
                </Show>
                <button type="button" onClick={cancelCellEdit}>
                  Cancel
                </button>
                <button type="button" class="primary-button" onClick={() => void saveCellEdit()}>
                  Apply
                </button>
              </div>
            </div>
          )}
        </Show>

        <footer class="statusbar">
          <span class={`status-${status().tone}`}>{status().text}</span>
          <span>{selectionSummary(result(), pageOffset())}</span>
          <div class="pager">
            <button type="button" disabled={!canPrev()} onClick={() => void runSql(pageOffset() - PAGE_SIZE)}>
              prev
            </button>
            <button type="button" disabled={!canNext()} onClick={() => void runSql(pageOffset() + PAGE_SIZE)}>
              next
            </button>
          </div>
        </footer>
      </section>
    </main>
  );
}

async function request<T>(body: DbRequest, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/db", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const payload = (await response.json()) as DbResponse<T>;
  if (!payload.ok) throw new Error(payload.error);
  return payload.result;
}

function CellValueView(props: { value: CellValue | ScalarValue; column: ColumnInfo }) {
  if (isUuidValue(props.value, props.column)) {
    return (
      <span class="uuid-cell" aria-label={props.value}>
        <For each={uuidStripeColors(props.value)}>{(color) => <span style={{ color }}>●</span>}</For>
      </span>
    );
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

function asScalar(value: CellValue): ScalarValue | undefined {
  if (isPreviewCell(value)) return undefined;
  return value;
}

function sameEditedValue(value: ScalarValue, original: ScalarValue) {
  if (value == null) return original == null;
  return String(value) === cellText(original);
}

function primaryKeyForRow(row: Record<string, CellValue>, columns: ColumnInfo[]) {
  const primaryColumns = columns.filter((column) => column.primaryKey);
  if (primaryColumns.length === 0) return null;

  const primaryKey: Record<string, ScalarValue> = {};
  for (const column of primaryColumns) {
    const value = asScalar(row[column.name]);
    if (value == null) return null;
    primaryKey[column.name] = value;
  }
  return primaryKey;
}

function rowIdentityLabel(row: Record<string, CellValue>, columns: ColumnInfo[]) {
  const primaryKey = primaryKeyForRow(row, columns);
  if (primaryKey == null) return "synthetic row";
  return Object.entries(primaryKey)
    .map(([key, value]) => `${key} = ${cellText(value)}`)
    .join(" / ");
}

function isPreviewCell(value: CellValue | ScalarValue): value is PreviewCell {
  return typeof value === "object" && value != null && "kind" in value;
}

function isUuidValue(value: CellValue | ScalarValue, column: ColumnInfo) {
  return column.kind === "uuid" && typeof value === "string";
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

function selectionSummary(result: ResultSet | null, offset: number) {
  if (result == null) return "no result";
  if (result.totalRows == null || result.totalRows.kind === "estimate") return `${result.records.length} rows`;
  if (result.records.length === 0) return `0 of ${result.totalRows.value}`;
  return `${offset + 1}-${offset + result.records.length} of ${result.totalRows.value}`;
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
  const message = messageOf(error);
  if (/Could not reach Postgres|Enter a Postgres URL|gateway cannot open Postgres/i.test(message)) return message;
  return "Could not reach Postgres. Check the URL, tunnel, and database process.";
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}
