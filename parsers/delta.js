/**
 * Delta computation: IFC extracted values vs EDB ground truth.
 * Returns per-metric comparison with status and diff value.
 */

const LAYERS = ['F1A','F3A','F5A','F7A','N1A','N3A','N5A','N7A'];

function compareVal(ifc, edb, type) {
    const bothNull = (ifc === null || ifc === undefined) && (edb === null || edb === undefined);
    if (bothNull) return { ifc: null, edb: null, diff: null, status: 'BOTH_NULL' };
    if (ifc === null || ifc === undefined) return { ifc: null, edb: edb, diff: null, status: 'IFC_ONLY' };
    if (edb === null || edb === undefined) return { ifc: ifc, edb: null, diff: null, status: 'EDB_ONLY' };

    const diff = ifc - edb;
    let status;
    if (type === 'dia') {
        status = (Math.round(ifc) === Math.round(edb)) ? 'MATCH' : 'DIFF';
    } else if (type === 'count') {
        status = (ifc === edb) ? 'MATCH' : 'DIFF';
    } else if (type === 'height') {
        // ±100mm tolerance (0.1m)
        status = Math.abs(diff) <= 0.1 ? 'MATCH' : 'DIFF';
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

        if (!ifcLayer && !edbLayer) return; // layer absent in both — skip

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
                height: compareVal(ifcV.height,  edbV.height, 'height'),
            },
        };

        // Tally summary
        const metrics = [
            delta.layers[layer].hori.minDia,
            delta.layers[layer].hori.maxDia,
            delta.layers[layer].hori.count,
            delta.layers[layer].vert.minDia,
            delta.layers[layer].vert.maxDia,
            delta.layers[layer].vert.height,
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

    delta.summary.passRate = delta.summary.total > 0
        ? +(delta.summary.match / delta.summary.total * 100).toFixed(1)
        : null;
    delta.passFail = (delta.summary.diff === 0 && delta.summary.ifcOnly === 0 && delta.summary.edbOnly === 0)
        ? 'PASS' : 'FAIL';

    return delta;
}

module.exports = { computeDelta, LAYERS };
