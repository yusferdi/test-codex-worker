import fs from 'fs-extra';
import path from 'path';
import readExcelFile from 'read-excel-file/node';
import { DOMParser } from '@xmldom/xmldom';

export async function readInputRows(filePath, job) {
  const ext = path.extname(job.original_filename || filePath).toLowerCase();
  const manualHeaderRow = resolveHeaderRow(job);
  const sheetMappings = resolveSheetMappings(job);
  const buffer = await fs.readFile(filePath);
  const signature = contentSignature(buffer);

  if (ext === '.txt' || ext === '.csv') {
    const text = normalizeText(buffer);
    const mappingJob = sheetMappings[0] ? jobForSheetMapping(job, sheetMappings[0]) : job;
    return readDelimitedRows(text, mappingJob, sheetMappings[0]?.header_row_index ?? manualHeaderRow, ext === '.txt');
  }

  if (signature === 'zip') {
    if (sheetMappings.length) {
      const sheets = await readXlsxMatrices(filePath);
      return rowsFromSheetMappings(sheets, sheetMappings, job);
    }
    const matrix = await readXlsxMatrix(filePath, job);
    return rowsFromMatrix(matrix, job, manualHeaderRow);
  }

  if (signature === 'markup' && ['.xml', '.xls', '.xlsx'].includes(ext)) {
    const text = normalizeText(buffer);
    if (!text.trimStart().startsWith('<')) {
      throw new Error('Format .xls binary lama belum didukung. Simpan ulang sebagai .xlsx, .csv, atau Excel XML.');
    }
    if (sheetMappings.length) {
      const sheets = readMarkupMatrices(text);
      return rowsFromSheetMappings(sheets, sheetMappings, job);
    }
    const matrix = readMarkupMatrix(text, job);
    return rowsFromMatrix(matrix, job, manualHeaderRow);
  }

  if (ext === '.xlsx') {
    if (sheetMappings.length) {
      const sheets = await readXlsxMatrices(filePath);
      return rowsFromSheetMappings(sheets, sheetMappings, job);
    }
    const matrix = await readXlsxMatrix(filePath, job);
    return rowsFromMatrix(matrix, job, manualHeaderRow);
  }

  if (ext === '.xml' || ext === '.xls') {
    const text = normalizeText(buffer);
    if (!text.trimStart().startsWith('<')) {
      throw new Error('Format .xls binary lama belum didukung. Simpan ulang sebagai .xlsx, .csv, atau Excel XML.');
    }
    if (sheetMappings.length) {
      const sheets = readMarkupMatrices(text);
      return rowsFromSheetMappings(sheets, sheetMappings, job);
    }
    const matrix = readMarkupMatrix(text, job);
    return rowsFromMatrix(matrix, job, manualHeaderRow);
  }

  throw new Error(`Format input ${ext || 'file'} tidak didukung worker.`);
}

async function readXlsxMatrix(filePath, job) {
  const sheets = await readXlsxMatrices(filePath);
  const selected = (job.sheet_name ? sheets.find(sheet => sheet.name === job.sheet_name) : null) || sheets[0];
  if (!selected) {
    throw new Error('Sheet input tidak ditemukan.');
  }
  return selected.data || [];
}

async function readXlsxMatrices(filePath) {
  const sheets = await readExcelFile(filePath, {
    parseNumber: value => value,
  });
  if (!Array.isArray(sheets)) {
    return [];
  }
  return sheets.map((sheet, index) => ({
    name: sheet?.sheet || `Sheet ${index + 1}`,
    data: sheet?.data || [],
  }));
}

function readMarkupMatrix(text, job) {
  const sheets = readMarkupMatrices(text);
  const selected = (job.sheet_name ? sheets.find(sheet => sheet.name === job.sheet_name) : null) || sheets[0];
  if (!selected) {
    throw new Error('Sheet input tidak ditemukan.');
  }
  return selected.data || [];
}

function readMarkupMatrices(text) {
  const trimmed = text.trimStart();
  if (/urn:schemas-microsoft-com:office:spreadsheet|<\s*(?:\w+:)?Workbook\b/i.test(trimmed)) {
    return readXmlSpreadsheetMatrices(text);
  }
  if (/<\s*html|<\s*table/i.test(trimmed)) {
    return readHtmlTableMatrices(text);
  }
  return readXmlSpreadsheetMatrices(text);
}

function readDelimitedRows(text, job, manualHeaderRow, allowSingleColumnList) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return [];

  const hasDelimiter = lines.slice(0, 5).some(line => /[,;\t|]/.test(line));
  if (allowSingleColumnList && !hasDelimiter) {
    return lines.map((line, idx) => ({
      rowIndex: idx + 1,
      nik: onlyDigits(line),
      kk: '',
      source: { NIK: line },
    }))
    .filter(row => row.nik);
  }

  const delimiter = detectDelimiter(lines.slice(0, 10)) || ',';
  const matrix = lines.map(line => parseDelimitedLine(line, delimiter));
  return rowsFromMatrix(matrix, job, manualHeaderRow);
}

function rowsFromMatrix(matrix, job, manualHeaderRow) {
  const { headers, records } = headersAndRecords(matrix, manualHeaderRow);
  if (!records.length) {
    return [];
  }

  const nikKey = resolveColumn(headers, job.nik_column);
  const kkKey = job.kk_column ? resolveColumn(headers, job.kk_column, false) : null;
  if (!nikKey) {
    throw new Error(`Kolom NIK "${job.nik_column}" tidak ditemukan.`);
  }

  return records.map(record => {
    const row = rowToObject(record.row, headers);
    return {
      rowIndex: record.originalIndex + 1,
      nik: onlyDigits(row[nikKey]),
      kk: kkKey ? onlyDigits(row[kkKey]) : '',
      source: row,
    };
  }).filter(row => row.nik);
}

function rowsFromSheetMappings(sheets, mappings, job) {
  const rows = [];
  for (const mapping of mappings) {
    const sheet = sheets.find(item => item.name === mapping.sheet_name);
    if (!sheet) {
      throw new Error(`Sheet "${mapping.sheet_name}" tidak ditemukan di input.`);
    }
    const mappedJob = jobForSheetMapping(job, mapping);
    let sheetRows = [];
    try {
      sheetRows = rowsFromMatrix(sheet.data || [], mappedJob, mapping.header_row_index);
    } catch (error) {
      throw new Error(`Sheet "${mapping.sheet_name}": ${error.message}`);
    }
    rows.push(...sheetRows.map(row => ({
      ...row,
      sheetName: mapping.sheet_name,
      source: {
        sheet_name: mapping.sheet_name,
        ...row.source,
      },
    })));
  }
  return rows;
}

function jobForSheetMapping(job, mapping) {
  return {
    ...job,
    sheet_name: mapping.sheet_name,
    nik_column: mapping.nik_column,
    kk_column: mapping.kk_column || '',
  };
}

function readXmlSpreadsheetMatrix(text, selectedSheet) {
  const sheets = readXmlSpreadsheetMatrices(text);
  const selected = (selectedSheet ? sheets.find(sheet => sheet.name === selectedSheet) : null) || sheets[0];
  if (!selected) {
    throw new Error('Worksheet XML tidak ditemukan.');
  }
  return selected.data || [];
}

function readXmlSpreadsheetMatrices(text) {
  const doc = new DOMParser({
    onError: () => {},
  }).parseFromString(text, 'text/xml');
  const worksheets = elementsByLocalName(doc, 'Worksheet');
  if (!worksheets.length) {
    throw new Error('Worksheet XML tidak ditemukan.');
  }

  return worksheets.map((worksheet, index) => ({
    name: xmlWorksheetName(worksheet, index),
    data: xmlSpreadsheetRows(worksheet),
  }));
}

function readHtmlTableMatrix(text, selectedSheet) {
  const sheets = readHtmlTableMatrices(text);
  const selected = (selectedSheet ? sheets.find(sheet => sheet.name === selectedSheet) : null) || sheets[0];
  if (!selected) {
    throw new Error('Tabel tidak ditemukan di file HTML Excel.');
  }
  return selected.data || [];
}

function readHtmlTableMatrices(text) {
  const doc = new DOMParser({
    onError: () => {},
  }).parseFromString(text, 'text/html');
  const tables = elementsByLocalName(doc, 'table');
  if (!tables.length) {
    throw new Error('Tabel tidak ditemukan di file HTML Excel.');
  }

  return tables.map((table, index) => ({
    name: htmlTableName(table, index),
    data: htmlTableRows(table),
  }));
}

function xmlSpreadsheetRows(worksheet) {
  const table = elementsByLocalName(worksheet, 'Table')[0];
  const rows = table ? elementsByLocalName(table, 'Row') : [];
  return rows.map(row => {
    const values = [];
    let cursor = 0;
    for (const cell of elementsByLocalName(row, 'Cell')) {
      const explicitIndex = Number(attributeValue(cell, ['ss:Index', 'Index']));
      if (explicitIndex > 0) {
        cursor = explicitIndex - 1;
      }
      const data = elementsByLocalName(cell, 'Data')[0];
      values[cursor] = cellText(data || cell);
      cursor += 1;
    }
    return denseRow(values);
  }).filter(row => row.some(value => String(value).trim() !== ''));
}

function htmlTableRows(table) {
  return elementsByLocalName(table, 'tr').map(row => {
    const values = [];
    for (const cell of Array.from(row.childNodes || [])) {
      if (!isElement(cell) || !['td', 'th'].includes(localName(cell))) {
        continue;
      }
      const colspan = Math.max(1, Number(attributeValue(cell, ['colspan'])) || 1);
      values.push(cellText(cell).replace(/\s+/g, ' ').trim());
      for (let i = 1; i < colspan; i += 1) {
        values.push('');
      }
    }
    return values;
  }).filter(row => row.some(value => String(value).trim() !== ''));
}

function xmlWorksheetName(worksheet, index) {
  return attributeValue(worksheet, ['ss:Name', 'Name']) || `Sheet ${index + 1}`;
}

function htmlTableName(table, index) {
  const caption = elementsByLocalName(table, 'caption')?.[0];
  const name = caption ? cellText(caption).trim() : '';
  return name || `Table ${index + 1}`;
}

function resolveColumn(headers, wanted, required = true) {
  const normalizedWanted = normalizeHeader(wanted);
  if (!normalizedWanted) {
    return required ? null : null;
  }
  const found = headers.find(header => normalizeHeader(header) === normalizedWanted)
    || headers.find(header => normalizeHeader(header).includes(normalizedWanted));
  if (!found && required) {
    return null;
  }
  return found || null;
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function onlyDigits(value) {
  return expandScientificNotation(String(value || '').trim()).replace(/\D/g, '');
}

function expandScientificNotation(value) {
  const match = String(value || '').trim().replace(',', '.').match(/^(\d+)(?:\.(\d+))?[eE]\+?(\d+)$/);
  if (!match) return String(value || '');
  const integer = match[1];
  const fraction = match[2] || '';
  const exponent = Number(match[3] || 0);
  if (exponent > 30) return String(value || '');
  const digits = `${integer}${fraction}`;
  const zeros = exponent - fraction.length;
  if (zeros >= 0) return `${digits}${'0'.repeat(zeros)}`;
  const split = digits.length + zeros;
  if (split <= 0) return `0.${'0'.repeat(Math.abs(split))}${digits}`;
  return `${digits.slice(0, split)}.${digits.slice(split)}`;
}

function detectDelimiter(lines) {
  const candidates = [',', ';', '\t', '|'];
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = lines.reduce((sum, line) => sum + line.split(candidate).length - 1, 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function resolveHeaderRow(job) {
  const payload = previewPayload(job);
  if (Number.isInteger(payload.header_row_index) && payload.header_row_index >= 0) {
    return payload.header_row_index;
  }
  return null;
}

function resolveSheetMappings(job) {
  const payload = previewPayload(job);
  const raw = Array.isArray(payload.sheet_mappings) ? payload.sheet_mappings : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const sheetName = String(item?.sheet_name || '').trim();
    const nikColumn = String(item?.nik_column || '').trim();
    if (!sheetName || !nikColumn || seen.has(sheetName)) {
      continue;
    }
    seen.add(sheetName);
    out.push({
      sheet_name: sheetName,
      nik_column: nikColumn,
      kk_column: String(item?.kk_column || '').trim(),
      header_row_index: Number.isInteger(item?.header_row_index) && item.header_row_index >= 0 ? item.header_row_index : null,
    });
  }
  return out;
}

function previewPayload(job) {
  try {
    return JSON.parse(job.preview_json || '{}') || {};
  } catch (_) {}
  return {};
}

function headersAndRecords(rawRows, manualHeaderRow = null) {
  const rows = rawRows
    .map((row, originalIndex) => ({ row: trimRow(row), originalIndex }))
    .filter(item => item.row.some(value => String(value).trim() !== ''));

  if (!rows.length) {
    return { headers: [], records: [] };
  }

  const maxColumns = rows.reduce((max, item) => Math.max(max, item.row.length), 0);
  if (looksLikeSingleNikList(rows)) {
    return {
      headers: maxColumns === 1 ? ['NIK'] : fallbackHeaders(maxColumns),
      records: rows,
    };
  }

  const headerOffset = Number.isInteger(manualHeaderRow) && manualHeaderRow >= 0 && manualHeaderRow < rows.length
    ? manualHeaderRow
    : detectHeaderIndex(rows.map(item => item.row));
  if (headerOffset === null) {
    return {
      headers: fallbackHeaders(maxColumns),
      records: rows,
    };
  }

  return {
    headers: normalizeHeaders(rows[headerOffset].row, maxColumns),
    records: rows.slice(headerOffset + 1),
  };
}

function trimRow(row) {
  return Array.from(row || []).map(cellToText);
}

function cellToText(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  return String(value ?? '').trim();
}

function rowToObject(cells, headers) {
  const row = {};
  headers.forEach((header, index) => {
    row[header] = String(cells[index] ?? '');
  });
  return row;
}

function looksLikeSingleNikList(rows) {
  const sample = rows.slice(0, 10);
  if (!sample.length) return false;

  let valid = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const item = sample[index];
    const filled = item.row.filter(value => String(value).trim() !== '');
    if (filled.length !== 1) return false;
    if (index === 0 && !/^\d{8,20}$/.test(onlyDigits(filled[0]))) return false;
    if (/^\d{8,20}$/.test(onlyDigits(filled[0]))) valid += 1;
  }
  return valid >= Math.max(1, Math.floor(sample.length * 0.7));
}

function detectHeaderIndex(rows) {
  let bestIndex = null;
  let bestScore = -999;
  const limit = Math.min(25, rows.length);
  for (let index = 0; index < limit; index += 1) {
    const score = headerScore(rows[index]);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestScore >= 3 ? bestIndex : null;
}

function headerScore(row) {
  const cells = row.map(value => String(value || '').trim()).filter(Boolean);
  if (!cells.length) return -999;

  let score = cells.length >= 2 ? cells.length * 2 : -5;
  let textCount = 0;
  let numericCount = 0;
  let keywordCount = 0;
  const unique = new Set();

  for (const cell of cells) {
    const clean = normalizeHeader(cell);
    if (!clean) continue;
    unique.add(clean);
    if (/[a-zA-Z\p{L}]/u.test(clean)) textCount += 1;
    if (/^\d+([.,]\d+)?$/.test(clean)) numericCount += 1;
    if (/\b(nik|no nik|nomor induk|kk|no kk|nama|alamat|desa|kelurahan|kecamatan|kabupaten|provinsi|tanggal|status)\b/u.test(clean)) {
      keywordCount += 1;
    }
  }

  score += textCount * 2;
  score += keywordCount * 6;
  if (cells.length === 1 && keywordCount > 0) score += 4;
  score += unique.size >= 2 ? 2 : -2;
  score -= numericCount * 4;
  if (numericCount > 0 && numericCount >= textCount) score -= 8;
  return score;
}

function normalizeHeaders(row, maxColumns) {
  const headers = [];
  const seen = new Set();
  for (let index = 0; index < maxColumns; index += 1) {
    const raw = String(row[index] ?? '').trim();
    const base = raw || `Kolom ${index + 1}`;
    let header = base;
    let key = normalizeHeader(header);
    let counter = 2;
    while (seen.has(key)) {
      header = `${base} (${counter})`;
      key = normalizeHeader(header);
      counter += 1;
    }
    seen.add(key);
    headers.push(header);
  }
  return headers;
}

function fallbackHeaders(maxColumns) {
  return Array.from({ length: maxColumns }, (_, index) => `Kolom ${index + 1}`);
}

function elementsByLocalName(root, name) {
  const out = [];
  const visit = node => {
    for (const child of Array.from(node.childNodes || [])) {
      if (isElement(child)) {
        if (localName(child) === name.toLowerCase()) {
          out.push(child);
        }
        visit(child);
      }
    }
  };
  visit(root);
  return out;
}

function localName(node) {
  return String(node.localName || node.nodeName || '').replace(/^.*:/, '').toLowerCase();
}

function isElement(node) {
  return node && node.nodeType === 1;
}

function attributeValue(element, names) {
  for (const name of names) {
    const value = element.getAttribute?.(name);
    if (value !== null && value !== undefined && value !== '') {
      return value;
    }
  }
  return '';
}

function cellText(node) {
  return String(node?.textContent ?? '').trim();
}

function denseRow(values) {
  const max = values.length ? Math.max(...Object.keys(values).map(Number)) : -1;
  const row = [];
  for (let index = 0; index <= max; index += 1) {
    row.push(String(values[index] ?? ''));
  }
  return row;
}

function normalizeText(buffer) {
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function contentSignature(buffer) {
  const head = buffer.subarray(0, 8);
  if (head[0] === 0x50 && head[1] === 0x4b) return 'zip';
  if (head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole';
  if (normalizeText(buffer.subarray(0, 512)).trimStart().startsWith('<')) return 'markup';
  return 'text';
}
