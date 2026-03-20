const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const ExcelJS  = require('exceljs');

const { db, DATA_DIR } = require('./db');
const IFCParser         = require('./parsers/ifc-parser');
const { parseEDB }      = require('./parsers/edb-parser');
const { computeDelta, LAYERS } = require('./parsers/delta');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Multer (memory storage — files passed directly to parsers) ────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 150 * 1024 * 1024 }, // 150 MB per file
});

// ── POST /api/submit ──────────────────────────────────────────────────────
app.post('/api/submit', upload.fields([
    { name: 'ifc', maxCount: 1 },
    { name: 'edb', maxCount: 1 },
]), async (req, res) => {
    try {
        const ifcFile  = req.files?.ifc?.[0];
        const edbFile  = req.files?.edb?.[0];
        const prodNo   = (req.body.prod_number || '').trim();

        if (!ifcFile) return res.status(400).json({ error: 'IFC file required.' });
        if (!edbFile) return res.status(400).json({ error: 'EDB Excel file required.' });

        // Cage name from filename (strip extension)
        const cageName = path.basename(ifcFile.originalname, path.extname(ifcFile.originalname));

        // ── Parse IFC ──────────────────────────────────────────────────
        const parser  = new IFCParser();
        const content = ifcFile.buffer.toString('utf8');
        const bars    = await parser.parseFile(content);
        const ifcData = parser.extractCheckerData(bars);

        // Save IFC to disk for future re-runs
        const ifcSavePath = path.join(DATA_DIR, 'ifcs', `${cageName}.ifc`);
        fs.writeFileSync(ifcSavePath, ifcFile.buffer);

        // ── Parse EDB ──────────────────────────────────────────────────
        const edbData = await parseEDB(edbFile.buffer);

        // ── Compute delta ──────────────────────────────────────────────
        const delta = computeDelta(ifcData, edbData);

        // ── Save to DB ─────────────────────────────────────────────────
        const stmt = db.prepare(`
            INSERT INTO submissions
                (cage_name, prod_number, edb_type, ifc_data, edb_data, delta, c01_ifc, pass_fail)
            VALUES
                (@cage_name, @prod_number, @edb_type, @ifc_data, @edb_data, @delta, @c01_ifc, @pass_fail)
        `);
        const info = stmt.run({
            cage_name  : cageName,
            prod_number: prodNo || null,
            edb_type   : edbData.edbType,
            ifc_data   : JSON.stringify(ifcData),
            edb_data   : JSON.stringify(edbData),
            delta      : JSON.stringify(delta),
            c01_ifc    : ifcData.c01Rejected ? 1 : 0,
            pass_fail  : delta.passFail,
        });

        res.json({
            id       : info.lastInsertRowid,
            cageName,
            prodNo,
            edbType  : edbData.edbType,
            ifcData,
            edbData,
            delta,
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/results ──────────────────────────────────────────────────────
app.get('/api/results', (req, res) => {
    const rows = db.prepare(`
        SELECT id, cage_name, prod_number, edb_type, submitted_at, c01_ifc, pass_fail,
               json_extract(delta, '$.summary') as summary
        FROM submissions
        ORDER BY submitted_at DESC
    `).all();
    res.json(rows.map(r => ({
        ...r,
        summary: r.summary ? JSON.parse(r.summary) : null,
    })));
});

// ── GET /api/results/:id ──────────────────────────────────────────────────
app.get('/api/results/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({
        ...row,
        ifc_data: JSON.parse(row.ifc_data),
        edb_data: JSON.parse(row.edb_data),
        delta   : JSON.parse(row.delta),
    });
});

// ── GET /api/export ───────────────────────────────────────────────────────
app.get('/api/export', async (req, res) => {
    const rows = db.prepare('SELECT * FROM submissions ORDER BY submitted_at ASC').all();

    const wb = new ExcelJS.Workbook();

    // ── Sheet 1: IFC Values ──────────────────────────────────────────
    addSheet(wb, 'IFC Values', rows, r => JSON.parse(r.ifc_data).checkerLayers);

    // ── Sheet 2: EDB Values ──────────────────────────────────────────
    addSheet(wb, 'EDB Values', rows, r => JSON.parse(r.edb_data).layers);

    // ── Sheet 3: Delta ───────────────────────────────────────────────
    addDeltaSheet(wb, rows);

    // ── Sheet 4: Summary ─────────────────────────────────────────────
    addSummarySheet(wb, rows);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ifc_checker_${datestamp()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
});

// ── Helper: build IFC or EDB layer sheet ──────────────────────────────────
function addSheet(wb, name, rows, layersFn) {
    const ws = wb.addWorksheet(name);

    // Build header rows
    const h1 = ['Cage Name', 'Prod No', 'EDB Type', 'Date'];
    const h2 = [null, null, null, null];
    LAYERS.forEach(layer => {
        h1.push(layer + ' Hori', null, null, layer + ' Ver', null, null);
        h2.push('Min Dia', 'Max Dia', 'Count', 'Min Dia', 'Max Dia', 'Height');
    });
    h1.push('C01 Rejected');
    h2.push(null);

    ws.addRow(h1);
    ws.addRow(h2);
    ws.getRow(1).font = { bold: true };
    ws.getRow(2).font = { bold: true, italic: true };

    rows.forEach(row => {
        const layers = layersFn(row);
        const cells  = [
            row.cage_name,
            row.prod_number,
            row.edb_type,
            row.submitted_at?.slice(0, 10),
        ];
        LAYERS.forEach(layer => {
            const l = layers?.[layer];
            cells.push(l?.hori?.minDia ?? null, l?.hori?.maxDia ?? null, l?.hori?.count ?? null);
            cells.push(l?.vert?.minDia ?? null, l?.vert?.maxDia ?? null, l?.vert?.height ?? null);
        });
        cells.push(name === 'IFC Values' ? (row.c01_ifc ? 'YES' : 'NO') : null);
        ws.addRow(cells);
    });

    ws.getColumn(1).width = 18;
    ws.getColumn(2).width = 10;
}

// ── Helper: Delta sheet ───────────────────────────────────────────────────
function addDeltaSheet(wb, rows) {
    const ws = wb.addWorksheet('Delta (IFC - EDB)');

    const h1 = ['Cage Name', 'Prod No', 'Pass/Fail', 'Match%'];
    const h2 = [null, null, null, null];
    LAYERS.forEach(layer => {
        h1.push(layer + ' H.Count', layer + ' V.Height', layer + ' H.MinDia', layer + ' H.MaxDia');
        h2.push('Δ Count', 'Δ Height(m)', 'Δ MinDia', 'Δ MaxDia');
    });
    ws.addRow(h1);
    ws.addRow(h2);
    ws.getRow(1).font = { bold: true };
    ws.getRow(2).font = { bold: true, italic: true };

    rows.forEach(row => {
        const delta   = JSON.parse(row.delta);
        const summary = delta.summary;
        const cells   = [row.cage_name, row.prod_number, row.pass_fail, summary.passRate];
        LAYERS.forEach(layer => {
            const dl = delta.layers?.[layer];
            cells.push(
                dl?.hori?.count?.diff  ?? null,
                dl?.vert?.height?.diff ?? null,
                dl?.hori?.minDia?.diff ?? null,
                dl?.hori?.maxDia?.diff ?? null,
            );
        });
        const exRow = ws.addRow(cells);
        // Colour pass/fail
        const pfCell = exRow.getCell(3);
        pfCell.fill = {
            type: 'pattern', pattern: 'solid',
            fgColor: { argb: row.pass_fail === 'PASS' ? 'FF1a4a2e' : 'FF4a1a1a' },
        };
        pfCell.font = { color: { argb: row.pass_fail === 'PASS' ? 'FF3fb950' : 'FFf85149' }, bold: true };
    });

    ws.getColumn(1).width = 18;
    ws.getColumn(3).width = 10;
    ws.getColumn(4).width = 9;
}

// ── Helper: Summary sheet ─────────────────────────────────────────────────
function addSummarySheet(wb, rows) {
    const ws = wb.addWorksheet('Summary');
    ws.addRow(['Metric', 'Value']).font = { bold: true };

    const total   = rows.length;
    const passes  = rows.filter(r => r.pass_fail === 'PASS').length;
    const c01s    = rows.filter(r => r.c01_ifc).length;
    const ubars   = rows.filter(r => r.edb_type === 'ubar').length;
    const struts  = rows.filter(r => r.edb_type === 'strut').length;

    // Per-metric fail counts
    const metricFails = {};
    rows.forEach(row => {
        const delta = JSON.parse(row.delta);
        LAYERS.forEach(layer => {
            const dl = delta.layers?.[layer];
            if (!dl) return;
            ['hori.count','vert.height','hori.minDia','hori.maxDia','vert.minDia','vert.maxDia'].forEach(key => {
                const [face, metric] = key.split('.');
                const m = dl[face]?.[metric];
                if (m && m.status === 'DIFF') {
                    const k = `${layer} ${key}`;
                    metricFails[k] = (metricFails[k] || 0) + 1;
                }
            });
        });
    });

    ws.addRow(['Total cages', total]);
    ws.addRow(['PASS', passes]);
    ws.addRow(['FAIL', total - passes]);
    ws.addRow(['Pass rate', total > 0 ? `${(passes/total*100).toFixed(1)}%` : '-']);
    ws.addRow(['C01 Rejected (IFC)', c01s]);
    ws.addRow(['U-bar EDB', ubars]);
    ws.addRow(['Strut EDB', struts]);
    ws.addRow([]);
    ws.addRow(['Top failing metrics', 'Fail count']).font = { bold: true };
    Object.entries(metricFails)
        .sort((a,b) => b[1] - a[1])
        .slice(0, 20)
        .forEach(([k, v]) => ws.addRow([k, v]));

    ws.getColumn(1).width = 30;
    ws.getColumn(2).width = 14;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function datestamp() { return new Date().toISOString().slice(0,10).replace(/-/g,''); }

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`IFC Checker running on http://localhost:${PORT}`));
