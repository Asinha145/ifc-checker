/**
 * EDB Excel Parser — Span Lookup sheet
 *
 * Detection (cell B33):
 *   'UDL Factor' → U-bar EDB  (F1–F6, N1–N6, UDL=C33, Wall=C35)
 *   'N6'         → Strut EDB  (F1–F8, N1–N8, UDL=C37, Wall=C39)
 *
 * Column map (both types):
 *   Col C = Min Dia  (col index 3, 1-based)
 *   Col D = Max Dia  (col index 4)
 *   Col E = Count    (horizontal lacers — odd ATK rows F1,F3…)
 *   Col F = Height   (vertical bar height — even ATK rows F2,F4…)
 *
 * ATK parity rule: odd row = horizontal, even row = vertical
 *   F1+F2 → F1A,  F3+F4 → F3A,  F5+F6 → F5A,  F7+F8 → F7A
 *   N1+N2 → N1A,  N3+N4 → N3A,  N5+N6 → N5A,  N7+N8 → N7A
 */

const ExcelJS = require('exceljs');

// EDB row layouts
const UBAR_LAYOUT = {
    fRows: [20, 21, 22, 23, 24, 25],          // F1–F6
    nRows: [26, 27, 28, 29, 30, 31],          // N1–N6
    udlRow: 33, udlCol: 3,
    wallRow: 35, wallCol: 3,
};
const STRUT_LAYOUT = {
    fRows: [20, 21, 22, 23, 24, 25, 26, 27],  // F1–F8
    nRows: [28, 29, 30, 31, 32, 33, 34, 35],  // N1–N8
    udlRow: 37, udlCol: 3,
    wallRow: 39, wallCol: 3,
};

// ATK pairs: [horiRow, vertRow] → layerName
function buildLayerPairs(rows, face) {
    const pairs = [];
    for (let i = 0; i < rows.length; i += 2) {
        const num = i + 1; // 1,3,5,7…
        pairs.push({ layer: `${face}${num}A`, horiRow: rows[i], vertRow: rows[i + 1] });
    }
    return pairs;
}

function cellVal(ws, row, col) {
    const cell = ws.getRow(row).getCell(col);
    const v = cell.value;
    if (v === null || v === undefined) return null;
    if (typeof v === 'object' && v.result !== undefined) return v.result; // formula
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
}

function cellStr(ws, row, col) {
    const cell = ws.getRow(row).getCell(col);
    const v = cell.value;
    if (v === null || v === undefined) return null;
    if (typeof v === 'object' && v.result !== undefined) return String(v.result).trim();
    return String(v).trim();
}

async function parseEDB(buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    const ws = wb.getWorksheet('Span Lookup');
    if (!ws) throw new Error('Sheet "Span Lookup" not found in EDB file.');

    // Detect type
    const b33 = cellStr(ws, 33, 2);
    let edbType, layout;
    if (b33 === 'UDL Factor') {
        edbType = 'ubar';
        layout  = UBAR_LAYOUT;
    } else if (b33 === 'N6') {
        edbType = 'strut';
        layout  = STRUT_LAYOUT;
    } else {
        // fallback: guess by counting non-null N rows
        const n8 = cellStr(ws, 35, 2);
        edbType = (n8 === 'N8') ? 'strut' : 'ubar';
        layout  = edbType === 'strut' ? STRUT_LAYOUT : UBAR_LAYOUT;
        console.warn(`EDB type detection: B33="${b33}" unrecognised, guessing ${edbType}`);
    }

    const layers = {};

    const extractFace = (rows, face) => {
        const pairs = buildLayerPairs(rows, face);
        pairs.forEach(({ layer, horiRow, vertRow }) => {
            const h = {
                minDia : cellVal(ws, horiRow, 3),
                maxDia : cellVal(ws, horiRow, 4),
                count  : cellVal(ws, horiRow, 5),
            };
            const v = {
                minDia : cellVal(ws, vertRow, 3),
                maxDia : cellVal(ws, vertRow, 4),
                height : cellVal(ws, vertRow, 6), // col F
            };
            // Only store if at least one value present
            if (Object.values(h).some(x => x !== null) || Object.values(v).some(x => x !== null)) {
                layers[layer] = { hori: h, vert: v };
            }
        });
    };

    extractFace(layout.fRows, 'F');
    extractFace(layout.nRows, 'N');

    const udl      = cellVal(ws, layout.udlRow,  layout.udlCol);
    const wallWidth = cellVal(ws, layout.wallRow, layout.wallCol);

    return { edbType, layers, udl, wallWidth };
}

module.exports = { parseEDB };
