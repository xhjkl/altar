import type { ColumnSource, RelationRef } from "~/lib/db-contract";

/** PostgreSQL plan node before conservative structural decoding. */
export type PlanNode = Record<string, unknown>;

/** Output origins plus every base-relation scan, including repeats. */
export type QueryOrigin = {
  output: string[];
  origins: (ColumnSource | null)[];
  relations: RelationRef[];
};

type PlanContext = {
  aliases: Map<string, RelationRef | null>;
  relations: RelationRef[];
};

/** Conservative output provenance reconstructed from PostgreSQL's verbose plan. */
export function queryOrigin(plan: PlanNode): QueryOrigin | null {
  const output = plan.Output;
  if (!Array.isArray(output) || !output.every((value) => typeof value === "string")) return null;

  const context = collectPlanContext(plan, {
    aliases: new Map(),
    relations: [],
  });
  return {
    output,
    origins: output.map((value) => sourceForOutput(value, context.aliases, context.relations)),
    relations: context.relations,
  };
}

function collectPlanContext(plan: PlanNode, context: PlanContext) {
  const relationName = plan["Relation Name"];
  const schema = plan.Schema;
  const alias = plan.Alias;
  if (typeof relationName === "string" && typeof schema === "string") {
    const relation = { schema, name: relationName };
    // Preserve scan multiplicity; a self-join is not a single update target.
    context.relations.push(relation);
    addAlias(context.aliases, relationName, relation);
    if (typeof alias === "string" && alias !== relationName) addAlias(context.aliases, alias, relation);
  }

  const children = plan.Plans;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (isRecord(child)) collectPlanContext(child, context);
    }
  }

  return context;
}

function addAlias(aliases: Map<string, RelationRef | null>, alias: string, relation: RelationRef) {
  if (!aliases.has(alias)) {
    aliases.set(alias, relation);
    return;
  }
  // Reused names cannot establish a unique scan origin, even in a self-join.
  aliases.set(alias, null);
}

function sourceForOutput(
  value: string,
  aliases: Map<string, RelationRef | null>,
  relations: RelationRef[],
): ColumnSource | null {
  const path = parseIdentifierPath(value);
  if (path == null) return null;

  const column = path[path.length - 1];
  if (path.length === 1) {
    return relations.length === 1 ? { relation: relations[0], column } : null;
  }

  for (let index = path.length - 2; index >= 0; index -= 1) {
    const relation = aliases.get(path[index]);
    if (relation != null) return { relation, column };
  }

  return null;
}

function parseIdentifierPath(value: string) {
  const path: string[] = [];
  let index = 0;

  while (index < value.length) {
    if (value[index] === '"') {
      let text = "";
      index += 1;
      while (index < value.length) {
        if (value[index] === '"' && value[index + 1] === '"') {
          text += '"';
          index += 2;
        } else if (value[index] === '"') {
          index += 1;
          break;
        } else {
          text += value[index];
          index += 1;
        }
      }
      if (!text) return null;
      path.push(text);
    } else {
      const start = index;
      while (index < value.length && /[\p{L}0-9_$]/u.test(value[index])) index += 1;
      if (start === index) return null;
      path.push(value.slice(start, index));
    }

    if (index === value.length) break;
    if (value[index] !== ".") return null;
    index += 1;
  }

  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}
