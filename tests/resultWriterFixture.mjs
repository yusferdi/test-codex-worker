import assert from 'node:assert/strict';
import { buildEnrichedInputRows } from '../src/resultWriter.js';

const nik = '3171010101010001';
const inputRows = [
  { rowIndex: 1, sheetName: 'BNBA', nik, kk: '3171010101010002', source: { NIK: nik, NAMA: 'HAIRUL HADI', KK: '3171010101010002' } },
  { rowIndex: 14, sheetName: 'BNBA', nik, kk: '3171010101010002', source: { NIK: nik, NAMA: 'HAIRUL HADI', KK: '3171010101010002' } },
  { rowIndex: 20, sheetName: 'BNBA', nik: '3171010101010003', kk: '3171010101010004', source: { NIK: '3171010101010003', NAMA: 'JUMINI', KK: '3171010101010004' } },
];

function result(inputNik, name, kk, status) {
  return {
    nik: inputNik,
    nama: name,
    nama_sesuai_nik: name,
    nama_kepala_keluarga: name,
    nik_kepala_keluarga: inputNik,
    kk,
    kk_sama: 'YA',
    status,
    status_aktif: '1',
    status_meninggal: '0',
    anggota_keluarga_json: JSON.stringify([
      { nik: inputNik, nama: name, hub_kepala_keluarga: 'Kepala Keluarga', id_hub_kepala_keluarga: '1' },
    ]),
  };
}

const rows = buildEnrichedInputRows(inputRows, [
  result(nik, 'HAIRUL HADI', '3171010101010002', 'FOUND'),
  result(nik, 'HAIRUL HADI', '3171010101010002', 'CHANGED:1->2'),
  result('3171010101010003', 'JUMINI', '3171010101010004', 'CHANGED:1->2'),
]);

const header = rows[0];
const index = name => header.indexOf(name);
assert.deepEqual(header.slice(0, 4), ['TINDAK LANJ', 'PADAN DATA', 'BARIS INPUT', 'DUPLIKAT INPUT']);
assert.equal(rows[1][index('DUPLIKAT INPUT')], 'YA');
assert.equal(rows[2][index('DUPLIKAT INPUT')], 'YA');
assert.equal(rows[1][index('RUJUKAN BARIS DUPLIKAT')], 'BNBA!baris 14');
assert.equal(rows[2][index('RUJUKAN BARIS DUPLIKAT')], 'BNBA!baris 1');
assert.equal(rows[1][index('PADAN DATA')], 'YA');
assert.equal(rows[2][index('PADAN DATA')], 'YA');
assert.equal(rows[3][index('PADAN DATA')], 'YA');
assert.equal(rows[3][index('TINDAK LANJ')], 'SELESAI');

console.log('Result writer fixture OK');
