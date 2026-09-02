export function splitSqlStatements(sqlText: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let dollarTag: string | null = null;
  let i = 0;

  while (i < sqlText.length) {
    const ch = sqlText[i];
    const next = sqlText[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        current += ch;
      }
      i += 1;
      continue;
    }

    if (dollarTag) {
      if (sqlText.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        current += ch;
        i += 1;
      }
      continue;
    }

    if (inDoubleQuote) {
      current += ch;
      if (ch === '"') {
        if (next === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inDoubleQuote = false;
      }
      i += 1;
      continue;
    }

    if (inSingleQuote) {
      current += ch;
      if (ch === "'") {
        if (next === "'") {
          current += "'";
          i += 2;
          continue;
        }
        inSingleQuote = false;
      }
      i += 1;
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sqlText.slice(i));
      if (tagMatch) {
        dollarTag = tagMatch[0];
        current += tagMatch[0];
        i += tagMatch[0].length;
        continue;
      }
    }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}
