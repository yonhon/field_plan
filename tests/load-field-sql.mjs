// sql/field.sql の field.load_field が読む表を読み取る（tests/audit.test.mjs と tests/load-field.test.mjs が使う）
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIELD_SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "sql", "field.sql"), "utf8");

// 表の名前の集まり。関数が見つからなければ null
export function loadFieldTables(sql = FIELD_SQL) {
  const body = sql.match(/create or replace function field\.load_field\([\s\S]*?\nas \$\$([\s\S]*?)\n\$\$;/)?.[1];
  return body ? new Set([...body.matchAll(/from field\.([a-z_]+)/g)].map((match) => match[1])) : null;
}
