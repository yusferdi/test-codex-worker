import fs from 'fs-extra';
import path from 'path';

const NO_INPUT_NAME_LABEL = 'TIDAK MEMILIKI NAMA';
const NO_HEAD_FAMILY_LABEL = 'TIDAK ADA KEPALA KELUARGA';
const NO_FAMILY_MEMBERS_LABEL = 'DATA ANGGOTA TIDAK TERSEDIA';
const NO_PADAN_DATA_LABEL = 'DATA PADAN TIDAK DITEMUKAN';
const ERROR_CHECK_LABEL = 'ERROR CEK DATA';

const HEADERS = [
  'nik',
  'source_sheet',
  'input_nama',
  'nama',
  'nama_sesuai_nik',
  'nik_kepala_keluarga',
  'desil',
  'date',
  'status',
  'screenshot',
  'riwayat_file',
  'kk',
  'kk_sama',
  'nama_sama',
  'id_keluarga',
  'id_wilayah',
  'nama_kepala_keluarga',
  'alamat',
  'provinsi',
  'kabupaten',
  'kecamatan',
  'kelurahan',
  'peringkat_nasional',
  'peringkat_provinsi',
  'peringkat_kab_kota',
  'percentile_nasional',
  'jumlah_anggota_keluarga',
  'anggota_keluarga',
  'pekerjaan_sesuai_nik',
  'pekerjaan_kepala_keluarga',
  'status_aktif',
  'keterangan_deleted',
  'status_meninggal',
  'status_kepala_keluarga',
  'keterangan_deleted_kepala_keluarga',
  'status_meninggal_kepala_keluarga',
  'PKH',
  'SEMBAKO',
  'PBI',
  'OKT_DES_2025',
  'detail_keluarga_json',
  'desil_json',
  'anggota_keluarga_json',
  'error',
];

const MEMBER_HEADERS = [
  'input_nik',
  'id_keluarga',
  'no_kk',
  'idsemesta',
  'nik',
  'nama',
  'hub_kepala_keluarga',
  'pekerjaan_utama',
  'status_kedudukan_pekerjaan_utama',
  'keberadaan_anggota',
  'flag_aktif',
  'status_kpd',
  'id_hub_kepala_keluarga',
  'button_status_ortu',
  'button_status_dapodik',
  'status_meninggal',
  'keterangan_deleted',
];

const INPUT_RESULT_HEADERS = [
  'NIK INPUT',
  'NAMA SESUAI NIK',
  'NIK KEPALA KELUARGA',
  'NAMA KEPALA KELUARGA',
  'NOMOR KK',
  'DESIL',
  'KK SAMA DENGAN EXCEL',
  'NAMA SAMA DENGAN EXCEL',
  'STATUS NIK VS NAMA',
  'NIK BENAR BERDASARKAN NAMA',
  'ALAMAT',
  'PROVINSI',
  'KABUPATEN',
  'KECAMATAN',
  'KELURAHAN',
  'PERINGKAT NASIONAL',
  'PERINGKAT PROVINSI',
  'PERINGKAT KAB/KOTA',
  'PERCENTILE',
  'JUMLAH ANGGOTA KELUARGA',
  'PEKERJAAN SESUAI NIK',
  'PEKERJAAN KEPALA KELUARGA',
  'STATUS',
  'KETERANGAN_DELETED',
  'STATUS MENINGGAL',
  'HASIL CEK',
  'ERROR',
];

const HEAD_ONLY_HEADERS = [
  'NIK KEPALA KELUARGA',
  'NAMA KEPALA KELUARGA',
  'NOMOR KK',
  'DESIL',
  'PERINGKAT NASIONAL',
  'PERINGKAT PROVINSI',
  'PERINGKAT KAB/KOTA',
  'PERCENTILE',
  'ALAMAT',
  'PROVINSI',
  'KABUPATEN',
  'KECAMATAN',
  'KELURAHAN',
  'STATUS',
  'KETERANGAN_DELETED',
  'STATUS MENINGGAL',
  'PEKERJAAN KEPALA KELUARGA',
  'JUMLAH ANGGOTA KELUARGA TANGGUNGAN',
  'HASIL CEK',
  'ERROR',
];

const ENRICHED_ACTION_HEADERS = [
  'TINDAK LANJ',
  'PADAN DATA',
  'BARIS INPUT',
  'DUPLIKAT INPUT',
  'RUJUKAN BARIS DUPLIKAT',
  'SHEET INPUT',
  'CATATAN PADAN DATA',
];

const ENRICHED_VALIDATION_HEADERS = [
  'DESIL BY PADAN DATA',
  'DOMISILI SAMA',
  'KK SAMA',
  'NAMA INPUT DIPAKAI',
  'NAMA PADAN',
  'NAMA SAMA',
  'NIK ADA DI ANGGOTA',
  'STATUS NIK VS NAMA',
  'NIK BENAR BERDASARKAN NAMA',
  'KEPALA KELUARGA ADA',
  'STATUS AKTIF',
  'STATUS MENINGGAL',
];

const ENRICHED_PADAN_HEADERS = [
  'NIK KEPALA KELUARGA',
  'NAMA KEPALA KELUARGA',
  'NOMOR KK PADAN',
  'ALAMAT PADAN',
  'PROVINSI PADAN',
  'KABUPATEN PADAN',
  'KECAMATAN PADAN',
  'KELURAHAN PADAN',
  'PERINGKAT NASIONAL PADAN',
  'PERINGKAT PROVINSI PADAN',
  'PERINGKAT KAB/KOTA PADAN',
  'PERCENTILE PADAN',
  'JUMLAH ANGGOTA KELUARGA',
  'ANGGOTA KELUARGA PADAN',
  'HASIL CEK',
];

const REGION_INPUT_KEYS = {
  province: ['provinsi', 'propinsi', 'province'],
  regency: ['kabupaten', 'kabupaten kota', 'kab kota', 'kota', 'regency'],
  district: ['kecamatan', 'distrik', 'district'],
  village: ['kelurahan', 'desa', 'kampung', 'village'],
};

const REGION_JOB_KEYS = {
  province: ['target_province', 'province'],
  regency: ['target_regency', 'regency'],
  district: ['target_district', 'district'],
  village: ['target_village', 'village'],
};

const REGION_RESULT_KEYS = {
  province: 'provinsi',
  regency: 'kabupaten',
  district: 'kecamatan',
  village: 'kelurahan',
};

function resultOutputFilenames(originalFilename) {
  const inputBase = safeOutputBase(path.basename(String(originalFilename || ''), path.extname(String(originalFilename || ''))));
  const resultBase = `hasil_padan_data_${inputBase}`;
  return {
    base: resultBase,
    xlsx: `${resultBase}.xlsx`,
    csv: `${resultBase}.csv`,
    txt: `${resultBase}.txt`,
    fixCsv: `fix_bnba_${inputBase}.csv`,
    zip: `${resultBase}.zip`,
  };
}

function safeOutputBase(value) {
  const cleaned = String(value || 'input')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 96);
  return cleaned || 'input';
}

export class ResultWriter {
  constructor(jobDir, options = {}) {
    const outputFilenames = resultOutputFilenames(options.job?.original_filename || '');
    this.jobDir = jobDir;
    this.csvPath = path.join(jobDir, 'hasil.csv');
    this.txtPath = path.join(jobDir, 'hasil.txt');
    this.fixCsvPath = path.join(jobDir, 'fix_bnba.csv');
    this.xlsxPath = path.join(jobDir, outputFilenames.xlsx);
    this.packagePath = path.join(jobDir, outputFilenames.zip);
    this.outputFilenames = outputFilenames;
    this.detailJsonlPath = path.join(jobDir, 'detail_keluarga.jsonl');
    this.desilJsonlPath = path.join(jobDir, 'desil_keluarga.jsonl');
    this.anggotaJsonlPath = path.join(jobDir, 'anggota_keluarga.jsonl');
    this.inputRows = Array.isArray(options.inputRows) ? options.inputRows : [];
    this.job = options.job && typeof options.job === 'object' ? options.job : {};
    this.count = 0;
  }

  async init({ append = false } = {}) {
    await fs.ensureDir(this.jobDir);
    if (append && await fs.pathExists(this.csvPath)) {
      this.count = await this.existingRowCount();
      await fs.ensureFile(this.txtPath);
      await fs.ensureFile(this.detailJsonlPath);
      await fs.ensureFile(this.desilJsonlPath);
      await fs.ensureFile(this.anggotaJsonlPath);
      return;
    }

    this.count = 0;
    await fs.writeFile(this.csvPath, `${HEADERS.join(',')}\n`);
    await fs.writeFile(this.txtPath, `${HEADERS.join('\t')}\n`);
    await fs.writeFile(this.detailJsonlPath, '');
    await fs.writeFile(this.desilJsonlPath, '');
    await fs.writeFile(this.anggotaJsonlPath, '');
    await fs.remove(this.fixCsvPath).catch(() => {});
    await fs.remove(this.xlsxPath).catch(() => {});
    await fs.remove(path.join(this.jobDir, 'hasil.xlsx')).catch(() => {});
    await fs.remove(this.packagePath).catch(() => {});
    await fs.remove(path.join(this.jobDir, 'hasil.zip')).catch(() => {});
  }

  async append(result) {
    const row = HEADERS.map(header => result[header] ?? '');
    await fs.appendFile(this.csvPath, `${row.map(csvCell).join(',')}\n`);
    await fs.appendFile(this.txtPath, `${row.map(txtCell).join('\t')}\n`);
    await this.appendJsonlFiles(result);
    this.count += 1;
  }

  async finalize() {
    await this.writeXlsx();
    await this.writePackage();
    return this.packagePath;
  }

  async existingRowCount() {
    return (await this.existingSummary()).rowCount;
  }

  async existingSummary() {
    if (!await fs.pathExists(this.csvPath)) {
      return { rowCount: 0, errorCount: 0, statusErrorCount: 0, resultCounts: {} };
    }
    const text = await fs.readFile(this.csvPath, 'utf8');
    const rows = parseCsv(text);
    if (!rows.length || !sameRow(rows[0], HEADERS)) {
      return { rowCount: 0, errorCount: 0, statusErrorCount: 0, resultCounts: {} };
    }

    const statusIndex = HEADERS.indexOf('status');
    const errorIndex = HEADERS.indexOf('error');
    const resultCounts = {};
    let errorCount = 0;
    let statusErrorCount = 0;
    for (const row of rows.slice(1)) {
      const status = String(row[statusIndex] || 'UNKNOWN');
      resultCounts[status] = (resultCounts[status] || 0) + 1;
      if (status === 'ERROR') {
        statusErrorCount += 1;
      }
      if (status === 'ERROR' || String(row[errorIndex] || '').trim() !== '') {
        errorCount += 1;
      }
    }
    return { rowCount: Math.max(0, rows.length - 1), errorCount, statusErrorCount, resultCounts };
  }

  async appendJsonlFiles(result) {
    await appendJsonl(this.detailJsonlPath, {
      input_nik: result.nik,
      data: parseJsonOrEmpty(result.detail_keluarga_json),
      error: result.error || '',
      ts: result.date,
    });
    await appendJsonl(this.desilJsonlPath, {
      input_nik: result.nik,
      data: parseJsonOrEmpty(result.desil_json),
      error: result.error || '',
      ts: result.date,
    });

    const members = parseJsonOrEmpty(result.anggota_keluarga_json);
    await appendJsonl(this.anggotaJsonlPath, {
      input_nik: result.nik,
      id_keluarga: result.id_keluarga || '',
      no_kk: result.kk || '',
      data: Array.isArray(members) ? members : [],
      error: result.error || '',
      ts: result.date,
    });
  }

  async writeXlsx() {
    const summaryRows = await readCsvMatrix(this.csvPath);
    const results = matrixToObjects(summaryRows);
    const enrichedInputRows = buildEnrichedInputRows(this.inputRows, results, this.job);
    const padanSummaryRows = buildPadanSummaryRows(enrichedInputRows, this.job);
    const reviewRows = buildReviewRows(enrichedInputRows);
    const inputRows = buildInputResultRows(results, this.inputRows);
    const headRows = buildHeadOnlyRows(results);
    const memberRows = await readMemberMatrix(this.anggotaJsonlPath);
    await fs.writeFile(this.fixCsvPath, matrixToCsv(headRows));
    const sheets = [
      ...(enrichedInputRows.length > 1 ? [{
        name: 'INPUT + PADAN DATA',
        rows: enrichedInputRows,
        sourceStartColumn: ENRICHED_ACTION_HEADERS.length,
        sourceColumnCount: Math.max(0, enrichedInputRows[0].length - ENRICHED_ACTION_HEADERS.length - ENRICHED_VALIDATION_HEADERS.length - ENRICHED_PADAN_HEADERS.length),
        freezeColumns: 4,
        tabColor: '0F766E',
      }] : []),
      ...(padanSummaryRows.length > 1 ? [{ name: 'RINGKASAN PADAN', rows: padanSummaryRows, freezeColumns: 1, tabColor: '0369A1' }] : []),
      ...(reviewRows.length > 1 ? [{ name: 'PERLU CEK', rows: reviewRows, freezeColumns: 1, tabColor: 'DC2626' }] : []),
      { name: 'Ringkasan', rows: inputRows, freezeColumns: 1, tabColor: '1B6EA8' },
      { name: 'KEPALA KELUARGA SAJA', rows: headRows, freezeColumns: 1, tabColor: 'B7791F' },
      { name: 'Anggota Keluarga', rows: memberRows, freezeColumns: 1, tabColor: '475569' },
    ];
    await fs.writeFile(this.xlsxPath, createXlsx(sheets));
  }

  async writePackage() {
    const files = [
      [this.outputFilenames.csv, this.csvPath],
      [this.outputFilenames.txt, this.txtPath],
      [this.outputFilenames.fixCsv, this.fixCsvPath],
      [this.outputFilenames.xlsx, this.xlsxPath],
      ['anggota_keluarga.jsonl', this.anggotaJsonlPath],
      ['detail_keluarga.jsonl', this.detailJsonlPath],
      ['desil_keluarga.jsonl', this.desilJsonlPath],
      ['summary.json', path.join(this.jobDir, 'summary.json')],
    ];

    const entries = [];
    for (const [name, filePath] of files) {
      if (await fs.pathExists(filePath)) {
        entries.push({ name, data: await fs.readFile(filePath) });
      }
    }
    await fs.writeFile(this.packagePath, createZip(entries));
  }
}

export function resultFromError(entry, error) {
  const inputName = inputNameFromEntry(entry);
  return {
    nik: entry.nik,
    source_sheet: entry.sheetName || '',
    input_nama: inputName,
    nama: '',
    nama_sesuai_nik: '',
    nik_kepala_keluarga: '',
    desil: 'ERROR',
    date: new Date().toISOString(),
    status: 'ERROR',
    screenshot: '',
    riwayat_file: '',
    kk: '',
    kk_sama: '',
    nama_sama: inputName ? ERROR_CHECK_LABEL : NO_INPUT_NAME_LABEL,
    id_keluarga: '',
    id_wilayah: '',
    nama_kepala_keluarga: '',
    alamat: '',
    provinsi: '',
    kabupaten: '',
    kecamatan: '',
    kelurahan: '',
    peringkat_nasional: '',
    peringkat_provinsi: '',
    peringkat_kab_kota: '',
    percentile_nasional: '',
    jumlah_anggota_keluarga: '0',
    anggota_keluarga: '',
    pekerjaan_sesuai_nik: '',
    pekerjaan_kepala_keluarga: '',
    status_aktif: '',
    keterangan_deleted: '',
    status_meninggal: '',
    status_kepala_keluarga: '',
    keterangan_deleted_kepala_keluarga: '',
    status_meninggal_kepala_keluarga: '',
    PKH: 'TIDAK',
    SEMBAKO: 'TIDAK',
    PBI: '',
    OKT_DES_2025: 'TIDAK',
    detail_keluarga_json: '{}',
    desil_json: '{}',
    anggota_keluarga_json: '[]',
    error: error?.message || String(error),
  };
}

function csvCell(value) {
  const text = escapeSpreadsheetFormula(String(value ?? ''));
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function txtCell(value) {
  return escapeSpreadsheetFormula(String(value ?? ''))
    .replace(/\t/g, ' ')
    .replace(/[\r\n]+/g, ' | ');
}

function matrixToCsv(rows) {
  return `${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`;
}

function escapeSpreadsheetFormula(text) {
  return /^[=+\-@\t\r]/.test(text.trimStart()) ? `'${text}` : text;
}

async function appendJsonl(filePath, data) {
  await fs.appendFile(filePath, `${JSON.stringify(data)}\n`);
}

function parseJsonOrEmpty(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

async function readCsvMatrix(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  return parseCsv(text);
}

async function readMemberMatrix(filePath) {
  const rows = [MEMBER_HEADERS];
  if (!await fs.pathExists(filePath)) {
    return rows;
  }

  const text = await fs.readFile(filePath, 'utf8');
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const item = parseJsonOrEmpty(line);
    if (!item || !Array.isArray(item.data)) {
      continue;
    }
    for (const member of item.data) {
      rows.push(MEMBER_HEADERS.map(header => {
        if (header === 'input_nik') return item.input_nik || '';
        return member?.[header] ?? '';
      }));
    }
  }
  return rows;
}

function matrixToObjects(rows) {
  if (!Array.isArray(rows) || rows.length < 2) {
    return [];
  }
  const headers = rows[0] || [];
  return rows.slice(1).map(row => {
    const out = {};
    headers.forEach((header, index) => {
      out[header] = row[index] ?? '';
    });
    return out;
  });
}

export function buildEnrichedInputRows(inputRows, results, job = {}) {
  if (!Array.isArray(inputRows) || !inputRows.length) {
    return [];
  }
  const sourceHeaders = collectInputHeaders(inputRows);
  const resultBuckets = buildResultBuckets(results);
  const duplicateReferences = buildInputDuplicateReferences(inputRows);
  return [
    [...ENRICHED_ACTION_HEADERS, ...sourceHeaders, ...ENRICHED_VALIDATION_HEADERS, ...ENRICHED_PADAN_HEADERS],
    ...inputRows.map((entry, index) => {
      const source = entry?.source && typeof entry.source === 'object' ? entry.source : {};
      const result = orderedResultForEntry(entry, results, index) || findResultForEntry(entry, resultBuckets);
      const duplicate = duplicateReferences.get(index) || { status: 'TIDAK', references: '' };
      const domicileSame = result ? compareDomicile(entry, result, job) : '';
      const kkSame = result ? compareKk(entry, result) : '';
      const nikInFamily = result ? familyHasInputNik(entry, result) : '';
      const inputName = inputNameFromEntry(entry);
      const matchedName = result ? matchedNameForResult(result, inputName) : '';
      const nameSame = result ? nameSameForResult(result, inputName, matchedName) : '';
      const nikByName = result ? memberNikForInputName(result, inputName) : '';
      const nikNameStatus = result ? nikNameStatusLabel(entry, result, { nikInFamily, nameSame, nikByName }) : '';
      const nikByNameOutput = nikNameStatus === 'NIK INPUT BERBEDA - NAMA DITEMUKAN' ? nikByName : '';
      const headExists = result ? familyHasHead(result) : '';
      const activeStatus = result ? displayActiveStatus(result.status_aktif) : '';
      const deathStatus = result?.status_meninggal || '';
      const padan = result ? padanLabel(result, {
        domicileSame,
        kkSame,
        nikInFamily,
        headExists,
        nameSame,
        nikNameStatus,
        activeStatus,
        deathStatus,
      }) : 'BELUM DIPROSES';
      const notes = result
        ? padanNotes(entry, result, { domicileSame, kkSame, nikInFamily, nameSame, nikByName, nikNameStatus, headExists })
        : 'Belum ada hasil cek untuk NIK ini.';
      return [
        actionLabel(padan, duplicate.status),
        padan,
        entry?.rowIndex || index + 2,
        duplicate.status,
        duplicate.references,
        entry?.sheetName || source.sheet_name || '',
        notes,
        ...sourceHeaders.map(header => source[header] ?? ''),
        result ? displayDesil(result.desil) : '',
        domicileSame,
        kkSame,
        inputName || NO_INPUT_NAME_LABEL,
        matchedName,
        nameSame,
        nikInFamily,
        nikNameStatus,
        nikByNameOutput,
        headExists,
        activeStatus,
        deathStatus,
        result?.nik_kepala_keluarga || '',
        result?.nama_kepala_keluarga || '',
        result?.kk || '',
        result?.alamat || '',
        result?.provinsi || '',
        result?.kabupaten || '',
        result?.kecamatan || '',
        result?.kelurahan || '',
        result?.peringkat_nasional || '',
        result?.peringkat_provinsi || '',
        result?.peringkat_kab_kota || '',
        result?.percentile_nasional || '',
        result?.jumlah_anggota_keluarga || '',
        result ? memberListForResult(result) : '',
        result?.status || '',
      ];
    }),
  ];
}

function buildPadanSummaryRows(enrichedRows, job = {}) {
  if (!Array.isArray(enrichedRows) || enrichedRows.length < 2) {
    return [];
  }
  const header = enrichedRows[0];
  const rows = enrichedRows.slice(1);
  const indexes = enrichedHeaderIndexes(header);
  const reviewCount = rows.filter(row => isReviewNeeded(row, indexes)).length;
  const inputSummary = inputBasicSummaryFromJob(job);
  const initialRows = inputSummary ? buildInitialComparisonRows(inputSummary, rows, indexes, reviewCount) : [];
  return [
    ['METRIK', 'JUMLAH', 'CATATAN'],
    ...initialRows,
    ['Total input diproses', rows.length, 'Baris input yang memiliki NIK dan masuk proses worker.'],
    ['Padan data: YA', countEqual(rows, indexes.padan, 'YA'), 'NIK padan dan tidak ditandai perlu cek.'],
    ['Padan data: PERLU CEK', countEqual(rows, indexes.padan, 'PERLU CEK'), 'Data ditemukan tetapi parsial atau memiliki ketidaksesuaian penting.'],
    ['Padan data: TIDAK', countEqual(rows, indexes.padan, 'TIDAK'), 'NIK tidak ditemukan atau gagal dipadankan.'],
    ['Baris input duplikat', countEqual(rows, indexes.duplicate, 'YA'), 'Setiap baris duplikat menunjuk ke pasangan baris inputnya.'],
    ['Domisili sama', countEqual(rows, indexes.domicile, 'YA'), 'Berdasarkan kolom wilayah input atau target wilayah job.'],
    ['Domisili berbeda', countEqual(rows, indexes.domicile, 'TIDAK'), 'Prioritas audit wilayah.'],
    ['Domisili tidak bisa dicek: data padan tidak ditemukan', countEqual(rows, indexes.domicile, NO_PADAN_DATA_LABEL), 'Tidak ada data padan untuk membandingkan domisili.'],
    ['KK sama', countEqual(rows, indexes.kk, 'YA'), 'KK input cocok dengan data padan.'],
    ['KK berbeda', countEqual(rows, indexes.kk, 'TIDAK'), 'Prioritas audit keluarga.'],
    ['KK tidak bisa dicek: data padan tidak ditemukan', countEqual(rows, indexes.kk, NO_PADAN_DATA_LABEL), 'Tidak ada data padan untuk membandingkan KK.'],
    ['Nama berbeda', countEqual(rows, indexes.name, 'TIDAK'), 'Prioritas audit identitas.'],
    ['Nama input kosong', countEqual(rows, indexes.name, NO_INPUT_NAME_LABEL), 'Kolom nama input kosong/tidak terbaca.'],
    ['Nama tidak bisa dicek: data padan tidak ditemukan', countEqual(rows, indexes.name, NO_PADAN_DATA_LABEL), 'Tidak ada data padan untuk membandingkan nama.'],
    ['Nama tidak bisa dicek: error', countEqual(rows, indexes.name, ERROR_CHECK_LABEL), 'Worker gagal mengambil data pembanding.'],
    ['NIK tidak muncul di anggota', countEqual(rows, indexes.nikInFamily, 'TIDAK'), 'Biasanya perlu cek ketika hasil ditemukan lewat KK.'],
    ['Data anggota tidak tersedia', countEqual(rows, indexes.nikInFamily, NO_FAMILY_MEMBERS_LABEL), 'Daftar anggota keluarga tidak terbaca, sehingga NIK anggota tidak bisa divalidasi.'],
    ['Nama ditemukan, NIK input berbeda', countEqual(rows, indexes.nikNameStatus, 'NIK INPUT BERBEDA - NAMA DITEMUKAN'), 'Nama input ada di anggota KK, tetapi NIK input tidak sama dengan NIK anggota tersebut.'],
    ['Kepala keluarga tidak ada', countEqual(rows, indexes.headExists, 'TIDAK'), 'Daftar anggota KK tidak punya relasi Kepala Keluarga.'],
    ['Status tidak aktif', countEqual(rows, indexes.active, 'TIDAK AKTIF'), 'Perlu review kelayakan/keaktifan.'],
    ['Indikasi meninggal', rows.filter(row => deathIndicator(row[indexes.death])).length, 'Perlu validasi status individu.'],
    ['Total baris perlu cek', reviewCount, 'Baris ini dikumpulkan di sheet PERLU CEK.'],
  ];
}

function buildInitialComparisonRows(summary, rows, indexes, reviewCount) {
  const kkExcel = numberMetric(summary.households_excel_total);
  const kkUnique = numberMetric(summary.kk_number_unique);
  const kkExpected = numberMetric(summary.households_effective_expected || kkUnique || kkExcel);
  const peopleTotal = numberMetric(summary.people_total);
  const peopleUnique = numberMetric(summary.people_unique);
  const initialProblems = numberMetric(summary.problem_rows);
  const postPadanKk = uniqueDigitsFromRows(rows, indexes.kkPadan);
  const expectedSource = kkUnique > 0 ? 'KK unik dari Nomor KK Excel' : 'KK menurut penanda Excel';
  const noteParts = [
    summary.households_excel_source ? `Sumber KK Excel: ${summary.households_excel_source}` : '',
    summary.people_unique_source ? `Jiwa unik: ${summary.people_unique_source}` : '',
  ].filter(Boolean);
  return [
    ['Ringkasan Excel awal', '', noteParts.join(' | ') || 'Dihitung dari file upload sebelum worker memadankan data.'],
    ['KK awal menurut Excel', kkExcel, 'Diambil dari penanda seperti NO URUT KK/No. bila polanya valid.'],
    ['KK unik dari Nomor KK Excel', kkUnique, 'Tidak dijumlahkan dengan KK awal; ini pembanding nomor keluarga unik.'],
    ['Pembanding KK utama', kkExpected, `${expectedSource}. Angka ini dipakai untuk cek sesuai/berbeda setelah padan.`],
    ['Jiwa awal terbaca', peopleTotal, 'Baris penduduk yang terbaca dari file, separator tidak dihitung sebagai jiwa.'],
    ['Jiwa unik awal', peopleUnique, 'Berdasarkan NIK unik, atau nama/baris bila NIK tidak tersedia.'],
    ['Baris Excel perlu cek awal', initialProblems, 'NIK kosong/tidak valid/duplikat atau nomor KK kosong pada file awal.'],
    ['KK unik setelah padan', postPadanKk, compareMetric(postPadanKk, kkExpected)],
    ['Jiwa diproses worker', rows.length, compareMetric(rows.length, peopleTotal)],
    ['Jiwa/baris bermasalah setelah padan', reviewCount, `Awal bermasalah ${initialProblems}; setelah padan ${reviewCount}.`],
    ['', '', ''],
  ];
}

function inputBasicSummaryFromJob(job) {
  const payload = previewPayload(job);
  if (payload.input_basic_summary && typeof payload.input_basic_summary === 'object' && Object.keys(payload.input_basic_summary).length) {
    return payload.input_basic_summary;
  }
  if (payload.basic_summary && typeof payload.basic_summary === 'object' && Object.keys(payload.basic_summary).length) {
    return payload.basic_summary;
  }
  const summaries = Array.isArray(payload.sheet_mappings)
    ? payload.sheet_mappings.map(item => item?.basic_summary).filter(item => item && typeof item === 'object')
    : [];
  return combineInputBasicSummaries(summaries);
}

function previewPayload(job) {
  try {
    return JSON.parse(String(job?.preview_json || '{}')) || {};
  } catch {
    return {};
  }
}

function combineInputBasicSummaries(summaries) {
  if (!Array.isArray(summaries) || !summaries.length) {
    return null;
  }
  const fields = [
    'row_count',
    'person_rows',
    'people_total',
    'people_unique',
    'nik_filled',
    'nik_valid_unique',
    'nik_invalid_rows',
    'duplicate_nik_rows',
    'people_without_nik',
    'name_unique',
    'kk_number_filled',
    'kk_number_unique',
    'people_without_kk',
    'household_sequence_count',
    'households_excel_total',
    'households_effective_expected',
    'empty_or_separator_rows',
    'problem_rows',
  ];
  const out = {};
  for (const field of fields) {
    out[field] = summaries.reduce((sum, item) => sum + numberMetric(item?.[field]), 0);
  }
  out.people_unique_source = summaries.length === 1 ? (summaries[0].people_unique_source || '') : 'akumulasi per sheet';
  out.households_excel_source = summaries.length === 1 ? (summaries[0].households_excel_source || '') : 'akumulasi per sheet';
  return out;
}

function numberMetric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function uniqueDigitsFromRows(rows, index) {
  if (index < 0) return 0;
  const values = new Set();
  for (const row of rows) {
    const value = onlyDigits(cellAt(row, index));
    if (value) {
      values.add(value);
    }
  }
  return values.size;
}

function compareMetric(actual, expected) {
  if (!expected) {
    return 'Tidak ada angka pembanding awal.';
  }
  const delta = actual - expected;
  if (delta === 0) {
    return 'SESUAI dengan pembanding awal.';
  }
  return `BERBEDA dari pembanding awal; selisih ${delta > 0 ? '+' : ''}${delta}.`;
}

function buildReviewRows(enrichedRows) {
  if (!Array.isArray(enrichedRows) || enrichedRows.length < 2) {
    return [];
  }
  const header = enrichedRows[0];
  const rows = enrichedRows.slice(1);
  const indexes = enrichedHeaderIndexes(header);
  const nikIndex = findHeaderIndex(header, ['nik input', 'nik', 'no nik', 'nomor nik']);
  const sourceIndex = findHeaderIndex(header, ['sheet input', 'sheet name', 'sheet_name', 'source sheet', 'source_sheet']);
  return [
    [
      'TINDAK LANJ',
      'BARIS INPUT',
      'NIK INPUT',
      'NAMA INPUT',
      'SOURCE SHEET',
      'PADAN DATA',
      'DUPLIKAT INPUT',
      'RUJUKAN BARIS DUPLIKAT',
      'DESIL BY PADAN DATA',
      'PERINGKAT NASIONAL PADAN',
      'PERINGKAT PROVINSI PADAN',
      'PERINGKAT KAB/KOTA PADAN',
      'DOMISILI SAMA',
      'KK SAMA',
      'NAMA INPUT DIPAKAI',
      'NAMA PADAN',
      'NAMA SAMA',
      'NIK ADA DI ANGGOTA',
      'STATUS NIK VS NAMA',
      'NIK BENAR BERDASARKAN NAMA',
      'KEPALA KELUARGA ADA',
      'STATUS AKTIF',
      'STATUS MENINGGAL',
      'HASIL CEK',
      'CATATAN PADAN DATA',
    ],
    ...rows
      .filter(row => isReviewNeeded(row, indexes))
      .map(row => [
        cellAt(row, indexes.action),
        cellAt(row, indexes.inputRow),
        cellAt(row, nikIndex),
        cellAt(row, indexes.inputName),
        cellAt(row, sourceIndex),
        cellAt(row, indexes.padan),
        cellAt(row, indexes.duplicate),
        cellAt(row, indexes.duplicateReferences),
        cellAt(row, indexes.desil),
        cellAt(row, indexes.rankNational),
        cellAt(row, indexes.rankProvince),
        cellAt(row, indexes.rankRegency),
        cellAt(row, indexes.domicile),
        cellAt(row, indexes.kk),
        cellAt(row, indexes.inputName),
        cellAt(row, indexes.matchedName),
        cellAt(row, indexes.name),
        cellAt(row, indexes.nikInFamily),
        cellAt(row, indexes.nikNameStatus),
        cellAt(row, indexes.nikByName),
        cellAt(row, indexes.headExists),
        cellAt(row, indexes.active),
        cellAt(row, indexes.death),
        cellAt(row, indexes.status),
        cellAt(row, indexes.notes),
      ]),
  ];
}

function enrichedHeaderIndexes(header) {
  return {
    action: header.indexOf('TINDAK LANJ'),
    padan: header.indexOf('PADAN DATA'),
    duplicate: header.indexOf('DUPLIKAT INPUT'),
    duplicateReferences: header.indexOf('RUJUKAN BARIS DUPLIKAT'),
    inputRow: header.indexOf('BARIS INPUT'),
    desil: header.indexOf('DESIL BY PADAN DATA'),
    rankNational: header.indexOf('PERINGKAT NASIONAL PADAN'),
    rankProvince: header.indexOf('PERINGKAT PROVINSI PADAN'),
    rankRegency: header.indexOf('PERINGKAT KAB/KOTA PADAN'),
    domicile: header.indexOf('DOMISILI SAMA'),
    kk: header.indexOf('KK SAMA'),
    inputName: header.indexOf('NAMA INPUT DIPAKAI'),
    matchedName: header.indexOf('NAMA PADAN'),
    name: header.indexOf('NAMA SAMA'),
    nikInFamily: header.indexOf('NIK ADA DI ANGGOTA'),
    nikNameStatus: header.indexOf('STATUS NIK VS NAMA'),
    nikByName: header.indexOf('NIK BENAR BERDASARKAN NAMA'),
    headExists: header.indexOf('KEPALA KELUARGA ADA'),
    active: header.indexOf('STATUS AKTIF'),
    death: header.indexOf('STATUS MENINGGAL'),
    kkPadan: header.indexOf('NOMOR KK PADAN'),
    status: header.indexOf('HASIL CEK'),
    notes: header.indexOf('CATATAN PADAN DATA'),
  };
}

function isReviewNeeded(row, indexes) {
  if (cellAt(row, indexes.duplicate) === 'YA') return true;
  if (cellAt(row, indexes.padan) !== 'YA') return true;
  if (cellAt(row, indexes.domicile) === 'TIDAK') return true;
  if (cellAt(row, indexes.kk) === 'TIDAK') return true;
  if (['TIDAK', NO_INPUT_NAME_LABEL].includes(cellAt(row, indexes.name))) return true;
  if (['TIDAK', NO_FAMILY_MEMBERS_LABEL].includes(cellAt(row, indexes.nikInFamily))) return true;
  if (cellAt(row, indexes.headExists) === 'TIDAK') return true;
  if (cellAt(row, indexes.active) === 'TIDAK AKTIF') return true;
  if (deathIndicator(cellAt(row, indexes.death))) return true;
  return false;
}

function actionLabel(padan, duplicateStatus) {
  if (duplicateStatus === 'YA') {
    return padan === 'TIDAK' ? 'CEK DUPLIKAT & DATA TIDAK PADAN' : 'CEK DUPLIKAT INPUT';
  }
  if (padan === 'YA') return 'SELESAI';
  if (padan === 'PERLU CEK') return 'PERLU CEK';
  if (padan === 'TIDAK') return 'CEK DATA TIDAK PADAN';
  return 'MENUNGGU PROSES';
}

function countEqual(rows, index, expected) {
  if (index < 0) return 0;
  return rows.filter(row => cellAt(row, index) === expected).length;
}

function cellAt(row, index) {
  return index >= 0 ? String(row[index] ?? '').trim() : '';
}

function findHeaderIndex(header, candidates) {
  const wanted = candidates.map(normalizeLooseKey);
  let fallback = -1;
  for (let index = 0; index < header.length; index += 1) {
    const key = normalizeLooseKey(header[index]);
    if (!key) continue;
    if (wanted.includes(key)) return index;
    if (fallback === -1 && wanted.some(candidate => key.includes(candidate))) {
      fallback = index;
    }
  }
  return fallback;
}

function collectInputHeaders(inputRows) {
  const headers = [];
  const seen = new Set();
  for (const entry of inputRows) {
    const source = entry?.source && typeof entry.source === 'object' ? entry.source : {};
    for (const header of Object.keys(source)) {
      const normalized = normalizeTextKey(header);
      if (!normalized || normalized === 'sheet_name' || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      headers.push(header);
    }
  }
  return headers.length ? headers : ['NIK INPUT'];
}

function buildInputDuplicateReferences(inputRows) {
  const groups = new Map();
  for (const [index, entry] of (Array.isArray(inputRows) ? inputRows : []).entries()) {
    const nik = onlyDigits(entry?.nik);
    if (!nik) continue;
    const group = groups.get(nik) || [];
    group.push({ index, reference: inputRowReference(entry, index) });
    groups.set(nik, group);
  }

  const references = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const item of group) {
      references.set(item.index, {
        status: 'YA',
        references: group
          .filter(candidate => candidate.index !== item.index)
          .map(candidate => candidate.reference)
          .join('; '),
      });
    }
  }
  return references;
}

function inputRowReference(entry, index) {
  const sheet = String(entry?.sheetName || entry?.source?.sheet_name || '').trim();
  const row = Number(entry?.rowIndex || 0) || index + 2;
  return `${sheet ? `${sheet}!` : ''}baris ${row}`;
}

function buildResultBuckets(results) {
  const buckets = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const key = onlyDigits(result?.nik);
    if (!key) {
      continue;
    }
    const bucket = buckets.get(key) || [];
    bucket.push(result);
    buckets.set(key, bucket);
  }
  return buckets;
}

function buildInputBuckets(inputRows) {
  const buckets = new Map();
  for (const entry of Array.isArray(inputRows) ? inputRows : []) {
    const key = onlyDigits(entry?.nik);
    if (!key) {
      continue;
    }
    const bucket = buckets.get(key) || [];
    bucket.push(entry);
    buckets.set(key, bucket);
  }
  return buckets;
}

function orderedResultForEntry(entry, results, index) {
  const result = Array.isArray(results) ? results[index] : null;
  if (!result) {
    return null;
  }
  return onlyDigits(result?.nik) === onlyDigits(entry?.nik) ? result : null;
}

function orderedInputForResult(result, inputRows, index) {
  const entry = Array.isArray(inputRows) ? inputRows[index] : null;
  if (!entry) {
    return null;
  }
  return onlyDigits(entry?.nik) === onlyDigits(result?.nik) ? entry : null;
}

function findResultForEntry(entry, buckets) {
  const key = onlyDigits(entry?.nik);
  if (!key || !buckets.has(key)) {
    return null;
  }
  const bucket = buckets.get(key);
  const sheetName = normalizeTextKey(entry?.sheetName || entry?.source?.sheet_name || '');
  if (sheetName) {
    return bucket.find(result => normalizeTextKey(result.source_sheet || '') === sheetName) || bucket[0];
  }
  return bucket[0];
}

function findInputEntryForResult(result, buckets) {
  const key = onlyDigits(result?.nik);
  if (!key || !buckets.has(key)) {
    return null;
  }
  const bucket = buckets.get(key);
  const sheetName = normalizeTextKey(result?.source_sheet || '');
  if (sheetName) {
    return bucket.find(entry => normalizeTextKey(entry?.sheetName || entry?.source?.sheet_name || '') === sheetName) || bucket[0];
  }
  return bucket[0];
}

function padanLabel(result, checks = {}) {
  const status = normalizeStatus(result?.status);
  if (!status || status === 'ERROR' || status === 'NOT_REGISTERED') {
    return 'TIDAK';
  }
  if (
    result?.error
    || status === 'FOUND_BY_KK'
    || status.startsWith('PARTIAL:')
    || checks.domicileSame === 'TIDAK'
    || checks.kkSame === 'TIDAK'
    || checks.nikInFamily === 'TIDAK'
    || checks.nikInFamily === NO_FAMILY_MEMBERS_LABEL
    || checks.headExists === 'TIDAK'
    || checks.nameSame === NO_INPUT_NAME_LABEL
    || checks.nameSame === 'TIDAK'
    || checks.nikNameStatus === 'NIK INPUT BERBEDA - NAMA DITEMUKAN'
    || checks.activeStatus === 'TIDAK AKTIF'
    || deathIndicator(checks.deathStatus)
  ) {
    return 'PERLU CEK';
  }
  return 'YA';
}

function compareKk(entry, result) {
  const unavailable = unavailablePadanLabel(result);
  if (unavailable) {
    return unavailable;
  }
  const explicit = String(result?.kk_sama || '').trim();
  if (explicit) {
    return explicit;
  }
  const inputKk = onlyDigits(entry?.kk || sourceValue(entry?.source, ['kk', 'no kk', 'nomor kk', 'nomor kartu keluarga']));
  const outputKk = onlyDigits(result?.kk);
  if (!inputKk || !outputKk) {
    return '';
  }
  return inputKk === outputKk ? 'YA' : 'TIDAK';
}

function compareDomicile(entry, result, job) {
  const unavailable = unavailablePadanLabel(result);
  if (unavailable) {
    return unavailable;
  }
  const compared = [];
  const mismatches = [];
  for (const level of Object.keys(REGION_RESULT_KEYS)) {
    const inputValue = regionInputValue(entry, job, level);
    const outputValue = String(result?.[REGION_RESULT_KEYS[level]] || '').trim();
    if (!inputValue || !outputValue) {
      continue;
    }
    compared.push(level);
    if (!sameRegionValue(inputValue, outputValue)) {
      mismatches.push(level);
    }
  }
  if (!compared.length) {
    return '';
  }
  return mismatches.length ? 'TIDAK' : 'YA';
}

function regionInputValue(entry, job, level) {
  const sourceMatch = sourceValue(entry?.source, REGION_INPUT_KEYS[level] || []);
  if (sourceMatch) {
    return sourceMatch;
  }
  for (const key of REGION_JOB_KEYS[level] || []) {
    const value = String(job?.[key] || '').trim();
    if (value) {
      return value;
    }
  }
  return '';
}

function sourceValue(source, candidates) {
  if (!source || typeof source !== 'object') {
    return '';
  }
  const wanted = candidates.map(normalizeLooseKey).filter(Boolean);
  for (const [key, value] of Object.entries(source)) {
    const normalized = normalizeLooseKey(key);
    if (!normalized) {
      continue;
    }
    const matched = wanted.some(candidate => normalized === candidate || normalized.includes(candidate));
    if (matched) {
      const text = String(value ?? '').trim();
      if (text) {
        return text;
      }
    }
  }
  return '';
}

function sameRegionValue(left, right) {
  return normalizeRegionValue(left) === normalizeRegionValue(right);
}

function normalizeRegionValue(value) {
  return normalizeLooseKey(value)
    .replace(/\b(?:provinsi|propinsi|kabupaten|kab|kota|kec|kecamatan|distrik|desa|kelurahan|kampung)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLooseKey(value) {
  return normalizeTextKey(value)
    .replace(/[._/\\-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function familyHasInputNik(entry, result) {
  const inputNik = onlyDigits(entry?.nik);
  if (!inputNik) {
    return '';
  }
  const members = parseJsonOrEmpty(result?.anggota_keluarga_json);
  if (!Array.isArray(members) || !members.length) {
    const status = normalizeStatus(result?.status);
    if (status === 'ERROR') return ERROR_CHECK_LABEL;
    if (status === 'NOT_REGISTERED') return NO_PADAN_DATA_LABEL;
    return status ? NO_FAMILY_MEMBERS_LABEL : '';
  }
  return members.some(member => onlyDigits(member?.nik) === inputNik) ? 'YA' : 'TIDAK';
}

function nikNameStatusLabel(entry, result, checks = {}) {
  const inputNik = onlyDigits(entry?.nik);
  if (!inputNik) {
    return '';
  }
  const status = normalizeStatus(result?.status);
  if (status === 'ERROR') {
    return ERROR_CHECK_LABEL;
  }
  if (status === 'NOT_REGISTERED') {
    return 'NIK TIDAK DITEMUKAN DI DATA PADAN';
  }
  const nikByNameList = nikCandidateList(checks.nikByName);
  if (checks.nameSame === NO_INPUT_NAME_LABEL) {
    if (checks.nikInFamily === 'YA') {
      return 'NIK DITEMUKAN - NAMA INPUT KOSONG';
    }
    if (checks.nikInFamily === 'TIDAK') {
      return 'NIK INPUT TIDAK ADA DI ANGGOTA - NAMA INPUT KOSONG';
    }
    if (checks.nikInFamily === NO_FAMILY_MEMBERS_LABEL) {
      return 'DATA ANGGOTA TIDAK TERSEDIA - NAMA INPUT KOSONG';
    }
    return 'NAMA INPUT KOSONG';
  }
  if (checks.nikInFamily === NO_FAMILY_MEMBERS_LABEL) {
    return checks.nameSame === 'YA'
      ? 'NAMA SESUAI - DATA ANGGOTA TIDAK TERSEDIA'
      : NO_FAMILY_MEMBERS_LABEL;
  }
  if (checks.nameSame === 'YA' && nikByNameList.length && !nikByNameList.includes(inputNik)) {
    return 'NIK INPUT BERBEDA - NAMA DITEMUKAN';
  }
  if (checks.nikInFamily === 'YA') {
    return checks.nameSame === 'YA' ? 'NIK DAN NAMA SESUAI' : 'NIK DITEMUKAN - NAMA BERBEDA';
  }
  if (checks.nameSame === 'YA' && nikByNameList.length) {
    return nikByNameList.includes(inputNik)
      ? 'NIK DAN NAMA SESUAI'
      : 'NIK INPUT BERBEDA - NAMA DITEMUKAN';
  }
  if (checks.nikInFamily === 'TIDAK') {
    return 'NIK INPUT TIDAK ADA DI ANGGOTA';
  }
  return '';
}

function padanNotes(entry, result, checks) {
  const status = normalizeStatus(result?.status);
  const notes = [];
  if (status === 'ERROR') {
    notes.push(`Error: ${result.error || 'gagal cek'}`);
  } else if (status === 'NOT_REGISTERED') {
    notes.push('NIK tidak ditemukan di data padan.');
  } else if (status === 'FOUND_BY_KK') {
    notes.push('Ditemukan lewat KK, cek ulang NIK anggota.');
  } else if (status.startsWith('PARTIAL:')) {
    notes.push('Data padan parsial.');
  } else if (status.startsWith('CHANGED:')) {
    notes.push('Desil berubah dari hasil/riwayat sebelumnya.');
  }

  if (checks.kkSame === 'TIDAK') {
    notes.push('KK input berbeda dengan KK padan.');
  }
  const nameSame = checks.nameSame || String(result?.nama_sama || '').trim();
  if (nameSame === NO_INPUT_NAME_LABEL) {
    notes.push('Kolom nama input kosong/tidak terbaca.');
  } else if (nameSame === 'TIDAK') {
    notes.push('Nama input berbeda dengan nama padan.');
  }
  if (checks.headExists === 'TIDAK') {
    notes.push('Tidak ada Kepala Keluarga di daftar anggota KK.');
  }
  if (checks.domicileSame === 'TIDAK') {
    notes.push('Domisili input/target berbeda dengan domisili padan.');
  }
  if (checks.nikInFamily === 'TIDAK') {
    notes.push('NIK input tidak muncul di daftar anggota keluarga.');
  }
  if (checks.nikInFamily === NO_FAMILY_MEMBERS_LABEL) {
    notes.push('Daftar anggota keluarga tidak tersedia, sehingga NIK anggota tidak bisa divalidasi.');
  }
  if (checks.nikNameStatus === 'NIK INPUT BERBEDA - NAMA DITEMUKAN' && checks.nikByName) {
    notes.push(`Nama input ditemukan di anggota keluarga, tetapi NIK input berbeda. NIK benar berdasarkan nama: ${checks.nikByName}.`);
  }
  if (displayActiveStatus(result?.status_aktif) === 'TIDAK AKTIF') {
    notes.push('Status tidak aktif.');
  }
  if (deathIndicator(result?.status_meninggal)) {
    notes.push('Ada indikasi status meninggal.');
  }
  if (result?.keterangan_deleted) {
    notes.push(`Keterangan deleted: ${result.keterangan_deleted}`);
  }
  if (!notes.length && padanLabel(result) === 'YA') {
    notes.push('Padan berdasarkan NIK input.');
  }
  return notes.join(' ');
}

function normalizeStatus(value) {
  return String(value || '').trim().toUpperCase();
}

function unavailablePadanLabel(result) {
  const status = normalizeStatus(result?.status);
  if (status === 'ERROR') {
    return ERROR_CHECK_LABEL;
  }
  if (status === 'NOT_REGISTERED') {
    return NO_PADAN_DATA_LABEL;
  }
  return '';
}

function deathIndicator(value) {
  const text = normalizeTextKey(value);
  return Boolean(text && !/^(?:0|false|n\/a|-)$/.test(text) && !/\b(?:tidak|belum|bukan|non)\b/.test(text));
}

function buildInputResultRows(results, inputRows = []) {
  const inputBuckets = buildInputBuckets(inputRows);
  return [
    INPUT_RESULT_HEADERS,
    ...results.map((result, index) => {
      const entry = orderedInputForResult(result, inputRows, index) || findInputEntryForResult(result, inputBuckets);
      const inputName = entry ? inputNameFromEntry(entry) : cleanDisplayValue(result.input_nama);
      const matchedName = matchedNameForResult(result, inputName);
      const nikInFamily = entry ? familyHasInputNik(entry, result) : '';
      const nameSame = nameSameForResult(result, inputName, matchedName);
      const kkSame = entry ? compareKk(entry, result) : (unavailablePadanLabel(result) || result.kk_sama || '');
      const nikByName = memberNikForInputName(result, inputName);
      const nikNameStatus = entry ? nikNameStatusLabel(entry, result, { nikInFamily, nameSame, nikByName }) : '';
      const nikByNameOutput = nikNameStatus === 'NIK INPUT BERBEDA - NAMA DITEMUKAN' ? nikByName : '';
      return [
        result.nik || '',
        matchedName || result.nama_sesuai_nik || result.nama || '',
        result.nik_kepala_keluarga || '',
        result.nama_kepala_keluarga || '',
        result.kk || '',
        displayDesil(result.desil),
        kkSame,
        nameSame,
        nikNameStatus,
        nikByNameOutput,
        result.alamat || '',
        result.provinsi || '',
        result.kabupaten || '',
        result.kecamatan || '',
        result.kelurahan || '',
        result.peringkat_nasional || '',
        result.peringkat_provinsi || '',
        result.peringkat_kab_kota || '',
        result.percentile_nasional || '',
        result.jumlah_anggota_keluarga || '',
        result.pekerjaan_sesuai_nik || '',
        result.pekerjaan_kepala_keluarga || '',
        displayActiveStatus(result.status_aktif),
        result.keterangan_deleted || '',
        result.status_meninggal || '',
        result.status || '',
        result.error || '',
      ];
    }),
  ];
}

function buildHeadOnlyRows(results) {
  const rows = [HEAD_ONLY_HEADERS];
  const seen = new Set();
  for (const result of results) {
    const key = headDedupKey(result);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push([
      result.nik_kepala_keluarga || '',
      result.nama_kepala_keluarga || '',
      result.kk || '',
      displayDesil(result.desil),
      result.peringkat_nasional || '',
      result.peringkat_provinsi || '',
      result.peringkat_kab_kota || '',
      result.percentile_nasional || '',
      result.alamat || '',
      result.provinsi || '',
      result.kabupaten || '',
      result.kecamatan || '',
      result.kelurahan || '',
      displayActiveStatus(result.status_kepala_keluarga || result.status_aktif),
      result.keterangan_deleted_kepala_keluarga || '',
      result.status_meninggal_kepala_keluarga || '',
      result.pekerjaan_kepala_keluarga || '',
      result.jumlah_anggota_keluarga || '',
      result.status || '',
      result.error || '',
    ]);
  }
  return rows;
}

function headDedupKey(result) {
  const headNik = onlyDigits(result.nik_kepala_keluarga);
  if (headNik) return `nik:${headNik}`;
  const kk = onlyDigits(result.kk);
  if (kk) return `kk:${kk}`;
  const id = String(result.id_keluarga || '').trim();
  if (id) return `id:${id}`;
  const name = normalizeTextKey(result.nama_kepala_keluarga);
  const address = normalizeTextKey(result.alamat);
  return name ? `name:${name}|${address}` : '';
}

function displayDesil(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^(?:n\/a|tidak\s*padan)$/i.test(text)) return 'TIDAK PADAN';
  if (text === '0') return 'BELUM DITENTUKAN';
  return text;
}

function displayActiveStatus(value) {
  const text = String(value ?? '').trim();
  if (text === '0') return 'TIDAK AKTIF';
  if (text === '1') return 'AKTIF';
  return text;
}

function inputNameFromEntry(entry) {
  const source = entry?.source && typeof entry.source === 'object' ? entry.source : {};
  const candidates = Object.entries(source)
    .map(([key, value]) => ({ key: normalizeTextKey(key), value: String(value ?? '').trim() }))
    .filter(item => item.key.includes('nama') && !/(sheet|alamat|provinsi|kabupaten|kecamatan|kelurahan|desa|komunitas|suku)/.test(item.key))
    .map(item => ({ ...item, priority: nameKeyPriority(item.key) }))
    .sort((a, b) => a.priority - b.priority);
  const bestPriority = candidates[0]?.priority;
  const best = candidates.find(item => item.priority === bestPriority && item.value);
  return best?.value || '';
}

function nameKeyPriority(key) {
  const looseKey = normalizeLooseKey(key);
  if (/(nama lengkap warga|nama warga|nama penduduk|nama penerima|nama anggota|nama kpm|nama pm)/.test(looseKey)) return 0;
  if (/\bnama lengkap\b/.test(looseKey)) return 1;
  if (/\bnama panggilan\b/.test(looseKey)) return 10;
  if (/^nama(?: \d+)?$/.test(looseKey)) return 20;
  return 30;
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function matchedNameForResult(result, inputName = '') {
  const memberName = memberNameForInputName(result, inputName);
  if (memberName) {
    return memberName;
  }
  const directMatch = [
    result?.nama_sesuai_nik,
    result?.nama,
    result?.nama_kepala_keluarga,
  ].map(cleanDisplayValue).find(candidate => namesMatch(inputName, candidate));
  if (directMatch) {
    return directMatch;
  }
  const sesuaiNik = cleanDisplayValue(result?.nama_sesuai_nik);
  if (sesuaiNik) {
    return sesuaiNik;
  }
  return normalizeStatus(result?.status) === 'FOUND_BY_KK' ? '' : cleanDisplayValue(result?.nama);
}

function nameMatchLabel(left, right) {
  const cleanLeft = normalizeNameForCompare(left);
  if (!cleanLeft) {
    return NO_INPUT_NAME_LABEL;
  }
  const cleanRight = normalizeNameForCompare(right);
  if (!cleanRight) {
    return 'TIDAK';
  }
  return cleanLeft === cleanRight ? 'YA' : 'TIDAK';
}

function nameSameForResult(result, inputName, matchedName) {
  const status = normalizeStatus(result?.status);
  if (status === 'ERROR') {
    return ERROR_CHECK_LABEL;
  }
  if (status === 'NOT_REGISTERED') {
    return NO_PADAN_DATA_LABEL;
  }
  return nameMatchLabel(inputName, matchedName);
}

function namesMatch(left, right) {
  const cleanLeft = normalizeNameForCompare(left);
  const cleanRight = normalizeNameForCompare(right);
  return Boolean(cleanLeft && cleanRight && cleanLeft === cleanRight);
}

function normalizeNameForCompare(value) {
  return normalizeTextKey(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function familyHasHead(result) {
  if (normalizeTextKey(result?.nama_kepala_keluarga) === normalizeTextKey(NO_HEAD_FAMILY_LABEL)) {
    return 'TIDAK';
  }

  const status = normalizeStatus(result?.status);
  if (status === 'ERROR') {
    return ERROR_CHECK_LABEL;
  }
  if (status === 'NOT_REGISTERED') {
    return NO_PADAN_DATA_LABEL;
  }

  const members = parseJsonOrEmpty(result?.anggota_keluarga_json);
  if (Array.isArray(members) && members.length) {
    return members.some(member => {
      const relation = normalizeLooseKey(member?.hub_kepala_keluarga);
      const relationId = String(member?.id_hub_kepala_keluarga ?? '').trim();
      return relationId === '1' || relation === 'kepala keluarga';
    }) ? 'YA' : 'TIDAK';
  }

  return result?.nik_kepala_keluarga || result?.nama_kepala_keluarga ? 'YA' : '';
}

function memberNameForInputName(result, inputName) {
  const wanted = normalizeNameForCompare(inputName);
  if (!wanted) {
    return '';
  }
  const members = parseJsonOrEmpty(result?.anggota_keluarga_json);
  if (!Array.isArray(members) || !members.length) {
    return '';
  }
  const member = members.find(item => normalizeNameForCompare(item?.nama) === wanted);
  return cleanDisplayValue(member?.nama);
}

function memberNikForInputName(result, inputName) {
  const wanted = normalizeNameForCompare(inputName);
  if (!wanted) {
    return '';
  }
  const members = parseJsonOrEmpty(result?.anggota_keluarga_json);
  if (!Array.isArray(members) || !members.length) {
    return '';
  }
  const niks = [];
  const seen = new Set();
  for (const member of members) {
    if (normalizeNameForCompare(member?.nama) !== wanted) {
      continue;
    }
    const nik = onlyDigits(member?.nik);
    if (nik && !seen.has(nik)) {
      seen.add(nik);
      niks.push(nik);
    }
  }
  return niks.join('; ');
}

function nikCandidateList(value) {
  return String(value || '')
    .split(/[;,\s]+/)
    .map(onlyDigits)
    .filter(Boolean);
}

function memberListForResult(result) {
  const existing = String(result?.anggota_keluarga || '').trim();
  if (existing) {
    return existing;
  }

  const members = parseJsonOrEmpty(result?.anggota_keluarga_json);
  if (!Array.isArray(members) || !members.length) {
    return '';
  }

  return members.map((member, index) => {
    const name = cleanDisplayValue(member?.nama) || 'Tanpa nama';
    const relation = cleanDisplayValue(member?.hub_kepala_keluarga);
    const nik = onlyDigits(member?.nik);
    const suffix = [
      relation ? `Hubungan: ${relation}` : '',
      nik ? `NIK: ${nik}` : '',
    ].filter(Boolean).join(' | ');
    return suffix ? `${index + 1}. ${name} | ${suffix}` : `${index + 1}. ${name}`;
  }).join('\n');
}

function cleanDisplayValue(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text && text !== '-' ? text : '';
}

function normalizeTextKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let current = '';
  let quoted = false;

  const pushCell = () => {
    row.push(current);
    current = '';
  };
  const pushRow = () => {
    pushCell();
    if (row.some(cell => String(cell).trim() !== '')) {
      rows.push(row);
    }
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }

    if (char === ',') {
      pushCell();
      continue;
    }

    if (char === '\r' || char === '\n') {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      pushRow();
      continue;
    }

    current += char;
  }

  if (current !== '' || row.length) {
    pushRow();
  }

  return rows;
}

function sameRow(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function createXlsx(sheets) {
  const worksheetEntries = sheets.map((sheet, index) => ({
    path: `xl/worksheets/sheet${index + 1}.xml`,
    xml: worksheetXml(sheet.rows, sheet),
  }));
  const workbook = workbookXml(sheets);
  const rels = workbookRelsXml(sheets);

  return createZip([
    { name: '[Content_Types].xml', data: contentTypesXml(sheets.length) },
    { name: '_rels/.rels', data: rootRelsXml() },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/styles.xml', data: stylesXml() },
    ...worksheetEntries.map(entry => ({ name: entry.path, data: entry.xml })),
  ]);
}

function worksheetXml(rows, sheet = {}) {
  const maxColumnCount = Math.max(1, ...rows.map(row => row.length));
  const lastCell = `${columnName(maxColumnCount)}${Math.max(1, rows.length)}`;
  const sheetPr = sheet.tabColor ? `<sheetPr><tabColor rgb="FF${xmlColor(sheet.tabColor)}"/></sheetPr>` : '';
  const dimension = `<dimension ref="A1:${lastCell}"/>`;
  const views = sheetViewsXml(sheet);
  const cols = worksheetColumnsXml(rows);
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const ref = `${columnName(columnIndex + 1)}${rowIndex + 1}`;
      const text = String(value ?? '');
      const preserveSpace = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : '';
      const styleId = cellStyleId(rows, rowIndex, columnIndex, sheet);
      const styleAttr = styleId ? ` s="${styleId}"` : '';
      return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t${preserveSpace}>${xmlEscape(text)}</t></is></c>`;
    }).join('');
    const rowAttrs = rowIndex === 0 ? ' ht="24" customHeight="1"' : '';
    return `<row r="${rowIndex + 1}"${rowAttrs}>${cells}</row>`;
  }).join('');
  const filter = rows.length > 1 ? `<autoFilter ref="A1:${lastCell}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheetPr}${dimension}${views}<sheetFormatPr defaultRowHeight="18"/>${cols}<sheetData>${body}</sheetData>${filter}</worksheet>`;
}

function workbookXml(sheets) {
  const sheetNodes = sheets.map((sheet, index) => {
    const name = xmlEscape(sheet.name.slice(0, 31));
    return `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheetNodes}</sheets></workbook>`;
}

function workbookRelsXml(sheets) {
  const rels = [
    ...sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`),
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
  ].join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function rootRelsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
}

function contentTypesXml(sheetCount) {
  const sheetOverrides = Array.from({ length: sheetCount }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}</Types>`;
}

function sheetViewsXml(sheet) {
  const freezeRows = 1;
  const freezeColumns = Math.max(0, Number(sheet.freezeColumns || 0));
  const topLeft = `${columnName(freezeColumns + 1)}${freezeRows + 1}`;
  const paneAttrs = [
    freezeColumns ? `xSplit="${freezeColumns}"` : '',
    `ySplit="${freezeRows}"`,
    `topLeftCell="${topLeft}"`,
    `activePane="${freezeColumns ? 'bottomRight' : 'bottomLeft'}"`,
    'state="frozen"',
  ].filter(Boolean).join(' ');
  const selectionPane = freezeColumns ? 'bottomRight' : 'bottomLeft';
  return `<sheetViews><sheetView workbookViewId="0"><pane ${paneAttrs}/><selection pane="${selectionPane}" activeCell="${topLeft}" sqref="${topLeft}"/></sheetView></sheetViews>`;
}

function worksheetColumnsXml(rows) {
  const maxColumnCount = Math.max(1, ...rows.map(row => row.length));
  const header = rows[0] || [];
  const sampleRows = rows.slice(1, 301);
  const cols = [];
  for (let columnIndex = 0; columnIndex < maxColumnCount; columnIndex += 1) {
    const width = preferredColumnWidth(header[columnIndex], sampleRows.map(row => row[columnIndex]));
    cols.push(`<col min="${columnIndex + 1}" max="${columnIndex + 1}" width="${width.toFixed(1)}" bestFit="1" customWidth="1"/>`);
  }
  return `<cols>${cols.join('')}</cols>`;
}

function preferredColumnWidth(header, values) {
  const key = normalizeLooseKey(header);
  const maxLength = Math.max(
    String(header ?? '').length,
    ...values.map(value => visibleCellLength(value))
  );
  if (/\b(?:nik|kk|id keluarga|id wilayah)\b/.test(key)) return clampWidth(maxLength + 1, 16, 22);
  if (/\b(?:catatan|deskripsi|alamat|error|json)\b/.test(key)) return clampWidth(maxLength + 2, 24, 42);
  if (/\b(?:nama|pekerjaan)\b/.test(key)) return clampWidth(maxLength + 2, 18, 34);
  if (/\b(?:provinsi|kabupaten|kecamatan|kelurahan|domisili)\b/.test(key)) return clampWidth(maxLength + 2, 16, 30);
  if (/\b(?:status|padan|sama|desil|peringkat|percentile|hasil cek)\b/.test(key)) return clampWidth(maxLength + 2, 13, 24);
  return clampWidth(maxLength + 2, 10, 28);
}

function visibleCellLength(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .length;
}

function clampWidth(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || min));
}

function cellStyleId(rows, rowIndex, columnIndex, sheet) {
  const header = rows[0]?.[columnIndex] || '';
  const key = normalizeLooseKey(header);
  const value = String(rows[rowIndex]?.[columnIndex] ?? '').trim();
  if (rowIndex === 0) {
    const sourceStart = Number(sheet.sourceStartColumn || 0);
    const sourceEnd = sourceStart + Number(sheet.sourceColumnCount || 0);
    if (sheet.name === 'INPUT + PADAN DATA' && columnIndex >= sourceStart && columnIndex < sourceEnd) {
      return 9;
    }
    return sheet.name === 'INPUT + PADAN DATA' ? 2 : 1;
  }
  if (/\b(?:tindak lanjut|padan data|duplikat input|domisili sama|kk sama|nama sama|nik ada di anggota|status aktif|status meninggal|hasil cek|desil by padan data)\b/.test(key)) {
    return statusStyleId(value, key);
  }
  if (/\b(?:catatan|deskripsi|alamat|error)\b/.test(key)) {
    return value ? 10 : 11;
  }
  if (/\bjson\b/.test(key)) {
    return 8;
  }
  return 11;
}

function statusStyleId(value, key = '') {
  const text = normalizeTextKey(value).toUpperCase();
  if (!text) return 11;
  if (key.includes('duplikat input')) {
    if (text === 'YA') return 5;
    if (text === 'TIDAK') return 3;
  }
  if (key.includes('status meninggal')) {
    if (/^(?:0|FALSE|TIDAK|BELUM|N\/A|-)$/.test(text) || /\b(?:TIDAK|BELUM|BUKAN|NON)\b/.test(text)) return 3;
    return 4;
  }
  if (/\b(?:TIDAK|ERROR|NOT_REGISTERED|GAGAL|MENINGGAL)\b/.test(text)) return 4;
  if (/\b(?:CEK|DUPLIKAT|PERLU|BELUM|PARTIAL|FOUND_BY_KK|CHANGED|DIPROSES|N\/A)\b/.test(text)) return 5;
  if (/\b(?:YA|AKTIF|NEW|FOUND|UNCHANGED|PADAN|SELESAI)\b/.test(text)) return 3;
  if (/^\d+(?:[.,]\d+)?$/.test(text)) return 6;
  return 6;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3">
    <font><sz val="11"/><color rgb="FF111827"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FF0F172A"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="10">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0F3F32"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDBEAFE"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFBEB"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="12">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="8" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="8" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="9" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`.replace(/\n\s*/g, '');
}

function xmlColor(value) {
  const color = String(value || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  return color.length === 6 ? color : '0F766E';
}

function columnName(index) {
  let name = '';
  let current = index;
  while (current > 0) {
    const mod = (current - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    current = Math.floor((current - mod) / 26);
  }
  return name;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function createZip(entries) {
  const buffers = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const crc = crc32(data);
    const { time, date } = dosDateTime(new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    buffers.push(local, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuffer);

    offset += local.length + nameBuffer.length + data.length;
  }

  const centralSize = central.reduce((sum, buffer) => sum + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...buffers, ...central, end]);
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
