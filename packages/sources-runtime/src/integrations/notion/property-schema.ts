export interface NotionPropertySchemaSummary {
  name: string;
  propertyKey: string;
  id: string | null;
  description?: string;
  type: string;
  config_keys: string[];
  config: unknown;
  [key: string]: unknown;
}

export function notionPropertySchemaSummary(properties: unknown): NotionPropertySchemaSummary[] {
  if (!isRecord(properties)) return [];
  return Object.entries(properties).map(([name, raw]) => {
    const property = isRecord(raw) ? raw : {};
    const type = nullableString(property.type) ?? "unknown";
    const typed = isRecord(property[type]) ? property[type] : {};
    const description = nullableString(property.description);
    const summary: NotionPropertySchemaSummary = {
      name: nullableString(property.name) ?? name,
      propertyKey: name,
      id: nullableString(property.id),
      type,
      config_keys: Object.keys(typed).sort(),
      config: normalizedSchemaConfig(typed),
      ...notionPropertySchemaDetails(type, typed),
    };
    if (description !== null) summary.description = description;
    return summary;
  });
}

function notionPropertySchemaDetails(type: string, typed: Record<string, unknown>): Record<string, unknown> {
  if (type === "select" || type === "multi_select" || type === "status") {
    const baseOptions = arrayValue(typed.options).filter(isRecord).map(propertyOptionSummary);
    const baseGroups = arrayValue(typed.groups).filter(isRecord).map((group) => ({
      id: nullableString(group.id),
      name: nullableString(group.name),
      color: nullableString(group.color),
      option_ids: arrayValue(group.option_ids).filter((id): id is string => typeof id === "string"),
    }));
    const groupByOptionId = new Map<string, Record<string, unknown>>();
    for (const group of baseGroups) {
      for (const optionId of group.option_ids) {
        groupByOptionId.set(optionId, group);
      }
    }
    const options = baseOptions.map((option) => {
      const optionId = nullableString(option.id);
      const group = optionId ? groupByOptionId.get(optionId) : null;
      if (!group) return option;
      return {
        ...option,
        group_id: nullableString(group.id),
        group_name: nullableString(group.name),
        group_color: nullableString(group.color),
      };
    });
    const optionsById = new Map(options
      .map((option) => [nullableString(option.id), option] as const)
      .filter((entry): entry is readonly [string, Record<string, unknown>] => entry[0] !== null));
    return {
      options,
      groups: baseGroups.map((group) => {
        const optionIds = group.option_ids;
        const groupOptions = optionIds
          .map((id) => optionsById.get(id))
          .filter((option): option is Record<string, unknown> => option !== undefined);
        return {
          id: nullableString(group.id),
          name: nullableString(group.name),
          color: nullableString(group.color),
          option_ids: optionIds,
          option_names: groupOptions.map((option) => nullableString(option.name)).filter((name): name is string => name !== null),
          options: groupOptions.map((option) => ({ ...option })),
        };
      }),
    };
  }

  if (type === "relation") {
    const dualProperty = isRecord(typed.dual_property) ? typed.dual_property : {};
    const hasSingleProperty = "single_property" in typed && isRecord(typed.single_property);
    const singleProperty = hasSingleProperty ? typed.single_property as Record<string, unknown> : {};
    const relationType = nullableString(typed.type);
    return {
      data_source_id: nullableString(typed.data_source_id),
      database_id: nullableString(typed.database_id),
      relation_type: relationType,
      is_single_property: relationType === "single_property" || hasSingleProperty,
      is_dual_property: relationType === "dual_property" || Object.keys(dualProperty).length > 0,
      synced_property_id: nullableString(typed.synced_property_id) ?? nullableString(dualProperty.synced_property_id),
      synced_property_name: nullableString(typed.synced_property_name) ?? nullableString(dualProperty.synced_property_name),
      dual_property: Object.keys(dualProperty).length > 0 ? normalizedSchemaConfig(dualProperty) : null,
      single_property: hasSingleProperty ? normalizedSchemaConfig(singleProperty) : null,
    };
  }

  if (type === "rollup") {
    return {
      relation_property_id: nullableString(typed.relation_property_id),
      relation_property_name: nullableString(typed.relation_property_name),
      rollup_property_id: nullableString(typed.rollup_property_id),
      rollup_property_name: nullableString(typed.rollup_property_name),
      function: nullableString(typed.function),
    };
  }

  if (type === "formula") return { expression: nullableString(typed.expression) };
  if (type === "number") return { format: nullableString(typed.format) };
  if (type === "unique_id") return { prefix: nullableString(typed.prefix) };
  if (type === "button") return { button: normalizedSchemaConfig(typed) };
  if (type === "verification") return { verification: normalizedSchemaConfig(typed) };
  return {};
}

function propertyOptionSummary(option: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: nullableString(option.id),
    name: nullableString(option.name),
    color: nullableString(option.color),
  };
  const description = nullableString(option.description);
  if (description !== null) summary.description = description;
  const group = nullableString(option.group);
  if (group !== null) summary.group = group;
  return summary;
}

function normalizedSchemaConfig(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return summarizeComplexValue(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => normalizedSchemaConfig(entry, depth + 1));
  if (!isRecord(value)) return null;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "raw" && key !== "plain_text")
    .slice(0, 100)
    .map(([key, entry]) => [key, normalizedSchemaConfig(entry, depth + 1)]));
}

function summarizeComplexValue(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { type: "array", count: value.length };
  if (isRecord(value)) return { type: "object", keys: Object.keys(value).slice(0, 50) };
  return { type: typeof value };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
