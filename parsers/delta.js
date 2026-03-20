/**
 * Delta computation: IFC extracted values vs EDB ground truth.
 * Returns per-metric comparison with status and diff value.
 *
 * Empty-value rule:
 *   EDB value of 0 for dia/count means "no bars in this layer" — treated
 *   as empty, same as null. If both sides are empty → BOTH_NULL (no penalty).
 */

const LAYERS = ['F1A','F3A','F5A','F7A','N1A','N3A','N5A','N7A'];

// True if a value means "not present / empty layer"
function isEmpty(v, type) {
    if (v === null || v === undefined) return true;
    // EDB writes 0 for unused dia fields — treat as empty
    if ((type === 'dia' || type === 'count') && v === 0) return true;
    return false;
}

function compareVal(ifc, edb, type) {
    const ifcEmpty = isEmpty(ifc, type);
    const edbEmpty = isEmpty(edb, type);

    if (ifcEmpty && edbEmpty) return { ifc: null, edb: null, diff: null, status: 'BOTH_NULL' };
    if (ifcEmpty) return { ifc: null, edb: edb, diff: null, status: 'IFC_ONLY' };
    if (edbEmpty) return { ifc: ifc, edb: null, diff: null, status: 'EDB_ONLY' };

    const diff = ifc - edb;
    let status;
    if (type === 'dia') {
        status = (Math.round(ifc) === Math.round(edb)) ? 'MATCH' : 'DIFF';
    } else if (type === 'count') {
        status = (ifc === edb) ? 'MATCH' : 'DIFF';
    } else if (type === 'height') {
        status = Math.abs(diff) <= 0.1 ? 'MATCH' : 'DIFF'; // ±100mm tolerance
    } else {
        status = diff === 0 ? 'MATCH' : 'DIFF';
    }
    return { ifc: +ifc.toFixed(3), edb: +edb.toFixed(3), diff: +diff.toFixed(3), status };
}

function computeDelta(ifcData, edbData) {
    const delta = { layers: {}, summary: { total: 0, match: 0, diff: 0, ifcOnly: 0, edbOnly: 0 } };

    LAYERS.forEach(layer => {
        const ifcLayer = ifcData.checkerLayers[layer];
        const edbLayer = edbData.layers[layer];

        if (!ifcLayer && !edbLayer) return;

        const ifcH = ifcLayer?.hori || {};
        const ifcV = ifcLayer?.vert || {};
        const edbH = edbLayer?.hori || {};
        const edbV = edbLayer?.vert || {};

        delta.layers[layer] = {
            hori: {
                minDia: compareVal(ifcH.minDia, edbH.minDia, 'dia'),
                maxDia: compareVal(ifcH.maxDia, edbH.maxDia, 'dia'),
                count : compareVal(ifcH.count,  edbH.count,  'count'),
            },
            vert: {
                minDia: compareVal(ifcV.minDia, edbV.minDia, 'dia'),
                maxDia: compareVal(ifcV.maxDia, edbV.maxDia, 'dia'),
                height: compareVal(ifcV.height, edbV.height, 'height'),
            },
        };

        const metrics = [
            delta.layers[layer].hori.minDia, delta.layers[layer].hori.maxDia, delta.layers[layer].hori.count,
            delta.layers[layer].vert.minDia, delta.layers[layer].vert.maxDia, delta.layers[layer].vert.height,
        ];
        metrics.forEach(m => {
            if (m.status === 'BOTH_NULL') return;
            delta.summary.total++;
            if (m.status === 'MATCH')    delta.summary.match++;
            if (m.status === 'DIFF')     delta.summary.diff++;
            if (m.status === 'IFC_ONLY') delta.summary.ifcOnly++;
            if (m.status === 'EDB_ONLY') delta.summary.edbOnly++;
        });
    });

    // ── UDL and Wall Width ────────────────────────────────────────────
    // IFC cannot provide these directly; show EDB value for reference.
    // Excluded from pass/fail scoring.
    delta.udl = {
        ifc: ifcData.udl ?? null,
        edb: edbData.udl ?? null,
        status: ifcData.udl != null && edbData.udl != null
            ? (Math.abs(ifcData.udl - edbData.udl) < 0.001 ? 'MATCH' : 'DIFF')
            : 'EDB_ONLY',
    };
    delta.wallWidth = {
        ifc: ifcData.wallWidth ?? null,
        edb: edbData.wallWidth ?? null,
        status: ifcData.wallWidth != null && edbData.wallWidth != null
            ? (Math.abs(ifcData.wallWidth - edbData.wallWidth) < 0.001 ? 'MATCH' : 'DIFF')
            : 'EDB_ONLY',
    };

    delta.summary.passRate = delta.summary.total > 0
        ? +(delta.summary.match / delta.summary.total * 100).toFixed(1)
        : null;
    delta.passFail = (delta.summary.diff === 0 && delta.summary.ifcOnly === 0 && delta.summary.edbOnly === 0)
        ? 'PASS' : 'FAIL';

    return delta;
}

module.exports = { computeDelta, LAYERS };
