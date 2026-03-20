/**
 * IFC Rebar Analyzer – Parser
 *
 * Position resolution:
 *   1. Walk IFCLOCALPLACEMENT chain → absolute origin P + rotation matrix R.
 *   2. Build R from Axis (local Z) + RefDirection (local X) via Gram-Schmidt.
 *   3. Get per-bar offset from MappedItem → CartesianTransformationOperator3D.
 *   4. Start = P + R·O,  BarDir = R[:,0],  End = Start + BarDir × Length.
 *
 * Cage-axis detection: "unique perpendicular positions" ratio.
 *   For each global axis (X / Y / Z):
 *     • Split Avonmouth mesh bars into: parallel (|Dir·axis| ≥ 0.5) and
 *       perpendicular (|Dir·axis| < 0.5) groups.
 *     • Count how many unique positions each group has in the plane
 *       perpendicular to that axis (rounded to nearest 100 mm grid).
 *     • ratio = uniq_parallel / max(uniq_perp, 1)
 *   The axis with the HIGHEST ratio is the cage's long axis.
 *
 *   Why this works:
 *     - Vertical (longitudinal) bars are spaced around the cage perimeter
 *       → many unique positions in the perpendicular plane.
 *     - Horizontal (ring/spacer) bars all start from a fixed transverse
 *       position → very few unique positions in the perpendicular plane.
 *
 *   This beats a pure "weighted span" approach, which can be fooled when
 *   horizontal ring bars are longer than the vertical bars (so their total
 *   span exceeds the vertical bars' total span), causing weighted span to
 *   mis-identify the ring direction as the cage axis.
 *
 * ATK Layer Name fallback (stats only, classification unchanged):
 *   Bars that have an Avonmouth "Layer/Set" always use that for classification.
 *   Bars with NO Avonmouth layer (av_layer = null) and an ATK "Layer Name"
 *   matching the F/N naming convention (F6 → F5A, N6 → N5A, …) get an
 *   inferred Effective_Mesh_Layer for the horizontal-count and height stats.
 *   This is intentionally ONLY for av_layer=null bars so that bars correctly
 *   assigned to VS1, HS1, PRL, etc. are never re-routed into mesh stats.
 *
 * Rejection conditions (stored on the parser, read by main.js):
 *   • unknownCount  > 0  – bars with no Avonmouth layer at all
 *   • duplicateCount > 0 – same GlobalId appears more than once
 *   Either condition → isRejected = true → "C01 Rejected" banner shown.
 *
 * Stagger clustering (countUniqueHorizPositions):
 *   Horizontal bars (bars parallel to cage axis) are often split into 2-3 IFC
 *   entities at the same structural position due to staggered lapping.
 *   e.g. Bar A starts at Z=28305 and Bar B at Z=28372 (67mm apart) — they are
 *   the SAME structural ring position, just physically offset to pass each other.
 *
 *   Algorithm: Average-linkage hierarchical clustering on the 1D projection of
 *   each bar's start point along the perpendicular-to-cage axis (e.g. Z when
 *   cage axis = X). A threshold of 100mm is used.
 *
 *   Why AVERAGE linkage (not single / complete)?
 *   - Single linkage chains: A→B (80mm) → B→C (90mm) merges A,B,C even if A–C=170mm.
 *   - Complete linkage splits: requires ALL pairs ≤ T, so rejects valid 3-bar stagger.
 *   - Average linkage measures the mean of all pairwise distances between clusters,
 *     correctly splitting the lapping zone (where two structural positions interleave)
 *     while merging genuine 2–3 segment stagger groups (all gaps 5–98mm).
 *
 *   Validated on 2HD70731AC1.ifc: 47 F1A horizontal IFC entities → 16 clusters ✓
 */
class IFCParser {
    constructor() {
        this.entities        = new Map();
        this.propertiesDict  = new Map();
        this.entityToPsets   = new Map();
        this.psetToProps     = new Map();
        this._ptCache        = new Map();
        this._dirCache       = new Map();
        // Set after parseFile():
        this.cageAxis        = [0, 0, 1];
        this.cageAxisName    = 'Z';
        this.unknownCount    = 0;
        this.duplicateCount  = 0;
        this.isRejected      = false;
    }

    async parseFile(content) {
        const lines = content.replace(/\r/g, '').split('\n');
        if (!lines.length) throw new Error('Empty file.');
        console.log(`Lines: ${lines.length}`);

        this.buildEntityLookup(lines);
        this.buildPropertiesDict(lines);
        this.buildRelationshipIndex(lines);

        const bars = this.extractReinforcementBars(lines);
        this.resolveAllPositions(bars);
        this.calculateWeights(bars);
        this.classifyBars(bars);
        this.detectCageAxis(bars);
        this.tagOrientation(bars);
        this.tagEffectiveMeshLayer(bars);
        this.reclassifyMeshCouplers(bars); // ← CPLR bars: inferred mesh layer → retype as Mesh
        this.tagStaggerClusters(bars);   // ← average-linkage stagger grouping
        this.parseShapeCodes(bars);      // ← split Shape_Code into base + coupler suffix
        this.detectBarShapes(bars);
        this.computeRejectionStatus(bars);

        console.log(`Cage axis: ${this.cageAxisName} | Rejected: ${this.isRejected} (unknown=${this.unknownCount}, dups=${this.duplicateCount})`);
        console.log(`Done – ${bars.length} bars`);
        return bars;
    }

    // ── Entity / property / relationship builders ──────────────────────

    buildEntityLookup(lines) {
        const re = /^#(\d+)\s*=\s*(.+)$/;
        lines.forEach(l => {
            const m = l.match(re);
            if (m) this.entities.set(m[1], m[2]);
        });
        console.log(`Entities: ${this.entities.size}`);
    }

    buildPropertiesDict(lines) {
        const re = /^#(\d+)\s*=\s*IFCPROPERTYSINGLEVALUE\('([^']+)',.*?(?:IFCTEXT|IFCLABEL|IFCMASSMEASURE|IFCLENGTHMEASURE|IFCINTEGER|IFCIDENTIFIER)\('?([^')\s]+)'?\)/;
        lines.forEach(l => {
            const m = l.match(re);
            if (m) this.propertiesDict.set(m[1], { name: m[2], value: m[3] });
        });
        console.log(`Properties: ${this.propertiesDict.size}`);
    }

    buildRelationshipIndex(lines) {
        lines.forEach(l => {
            const relM = l.match(/IFCRELDEFINESBYPROPERTIES\('[^']+',\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*\(([^)]+)\),\s*#(\d+)\)/);
            if (relM) {
                const psetId = relM[2];
                (relM[1].match(/#(\d+)/g) || []).forEach(e => {
                    const id = e.slice(1);
                    if (!this.entityToPsets.has(id)) this.entityToPsets.set(id, []);
                    this.entityToPsets.get(id).push(psetId);
                });
            }
            const psetM = l.match(/^#(\d+)\s*=\s*IFCPROPERTYSET\([^,]+,\s*[^,]+,\s*'([^']+)',\s*[^,]+,\s*\(([^)]+)\)/);
            if (psetM) {
                const ids = (psetM[3].match(/#(\d+)/g) || []).map(p => p.slice(1));
                this.psetToProps.set(psetM[1], { name: psetM[2], props: ids });
            }
        });
        console.log(`Entity→Pset: ${this.entityToPsets.size}`);
    }

    // ── Bar extraction ─────────────────────────────────────────────────

    extractReinforcementBars(lines) {
        const bars = [];
        const re   = /#(\d+)\s*=\s*IFCREINFORCINGBAR\('([^']+)'.*?#(\d+),\s*#(\d+),\s*'?(ID[^',)]+)?'?.*?,\s*([\d.]+),/;
        lines.forEach(line => {
            if (!line.includes('IFCREINFORCINGBAR')) return;
            const m = line.match(re);
            if (!m) return;
            const nameM = line.match(/,'([^']+)',/);
            const bar = {
                _entityId         : m[1],
                _placementId      : m[3],
                _shapeId          : m[4],
                Entity_ID         : `#${m[1]}`,
                GlobalId          : m[2],
                Name              : nameM ? nameM[1] : '',
                ObjectId          : m[5] || 'Unknown',
                NominalDiameter_mm: parseFloat(m[6]) || 0,
                Source_Global_ID  : null,
                Rebar_ID          : null,
                Size              : null,
                Weight            : null,
                Total_Weight      : null,
                Length            : null,
                Avonmouth_ID      : null,
                Avonmouth_Layer_Set  : null,  // from Avonmouth pset
                ATK_Layer_Name       : null,  // from ATK Rebar pset
                Effective_Mesh_Layer : null,  // computed: Avonmouth mesh OR ATK inferred (av=null only)
                Shape_Code           : null,  // raw e.g. "00GM", "12LGF"
                Shape_Code_Base      : null,  // numeric/letter part e.g. "00", "12L"
                Coupler_Suffix       : null,  // e.g. "GM", "GF", "GMB", "GFB"
                Coupler_Type         : null,  // e.g. "Male", "Female", "Male Bridging", "Female Bridging"
                Rebar_Mark           : null,  // e.g. "503"
                Full_Rebar_Mark      : null,  // e.g. "S/503"
                Bar_Type          : null,
                Bar_Shape         : null,
                Orientation       : null,
                Calculated_Weight : null,
                Start_X: null, Start_Y: null, Start_Z: null,
                End_X  : null, End_Y  : null, End_Z  : null,
                Dir_X  : null, Dir_Y  : null, Dir_Z  : null,
                // Bend direction (lZ column of rotation matrix) for BS 8666 shaped rendering
                Bend_X : null, Bend_Y : null, Bend_Z : null,
                // BS 8666 shape dimensions from ATK Rebar pset
                Dim_A  : null, Dim_B  : null, Dim_C  : null,
                Stagger_Cluster_ID: null,   // e.g. "F1A_H03"  (set after cage-axis detection)
                Formula_Weight    : null,   // geometry-based: π×r²×L×7777 — always computed, used for UDL only
            };
            this.extractProperties(m[1], bar);
            bars.push(bar);
        });
        console.log(`Bars extracted: ${bars.length}`);
        return bars;
    }

    extractProperties(entityId, bar) {
        const psets = this.entityToPsets.get(entityId);
        if (!psets) return;
        psets.forEach(psetId => {
            const pi = this.psetToProps.get(psetId);
            if (!pi) return;
            const psetName = pi.name;
            const isATK    = psetName === 'ATK Rebar';
            const isICOS   = psetName === 'ICOS Rebar';
            pi.props.forEach(propId => {
                const p = this.propertiesDict.get(propId);
                if (!p) return;
                const { name: n, value: v } = p;
                if      (n === 'source_global_id') bar.Source_Global_ID    = v;
                else if (n === 'rebar_id')          bar.Rebar_ID            = v;
                // ── Weight: ATK Rebar 'Weight' and ICOS Rebar 'Weight' are authoritative per-bar values.
                // Only accept Weight from ATK or ICOS psets (never from arbitrary psets).
                // 'Total Weight'/'Total weight' is a schedule-level aggregate — never use it for per-bar.
                else if (n === 'Weight' && (isATK || isICOS)) {
                    const w = parseFloat(v);
                    if (w > 0) bar.Weight = w;
                }
                else if (n === 'Length')  bar.Length = parseFloat(v) || null;
                else if (n === 'ID'        && psetName === 'Avonmouth') bar.Avonmouth_ID        = v;
                else if (n === 'Layer/Set' && psetName === 'Avonmouth') bar.Avonmouth_Layer_Set = v || null;
                // ATK Rebar: layer name
                else if (n === 'Layer Name' && isATK) bar.ATK_Layer_Name = v;
                // ICOS Rebar: layer equivalent is the 'Name' field (e.g. 'FF1', 'NF2', 'O.LINK')
                else if (n === 'Name' && isICOS && !bar.ATK_Layer_Name) bar.ATK_Layer_Name = v;
                else if (n === 'Size')           { bar.Size = parseFloat(v) || null; }
                else if (n === 'Shape Code'  || n === 'Shape code')  { bar.Shape_Code = v; }
                else if (n === 'Rebar Mark'  || n === 'Rebar mark')  { bar.Rebar_Mark = v; }
                else if (n === 'Full Rebar Mark')    { bar.Full_Rebar_Mark = v; }
                else if (n === 'Dim A')              { bar.Dim_A = parseFloat(v) || null; }
                else if (n === 'Dim B')              { bar.Dim_B = parseFloat(v) || null; }
                else if (n === 'Dim C')              { bar.Dim_C = parseFloat(v) || null; }
            });
        });
        // Normalise blank Avonmouth layer to null
        if (bar.Avonmouth_Layer_Set === '') bar.Avonmouth_Layer_Set = null;
        // Fallback: if no ATK Rebar pset exists, use the IFCREINFORCINGBAR Name field
        // as ATK_Layer_Name. Some files (e.g. P1337 style) store the layer in 'Schedule
        // Reference Data' → 'Layer Name' but our parser only reads ATK Rebar pset.
        // The IFCREINFORCINGBAR Name field directly matches the ATK layer name.
        if (!bar.ATK_Layer_Name && bar.Name) bar.ATK_Layer_Name = bar.Name;
    }

    // ── Position resolution ────────────────────────────────────────────

    resolveAllPositions(bars) {
        let ok = 0;
        bars.forEach(bar => {
            try {
                const r = this._resolvePosition(bar._placementId, bar._shapeId, bar.Length || 0);
                if (r) {
                    [bar.Start_X, bar.Start_Y, bar.Start_Z] = r.start;
                    [bar.End_X,   bar.End_Y,   bar.End_Z  ] = r.end;
                    [bar.Dir_X,   bar.Dir_Y,   bar.Dir_Z  ] = r.dir;
                    // BendDir = lZ column of R (3rd column) — perpendicular to bar in bend plane
                    // Used by the 3D viewer for BS 8666 shaped bar rendering
                    if (r.bend) [bar.Bend_X, bar.Bend_Y, bar.Bend_Z] = r.bend;
                    ok++;
                }
            } catch (_) {}
        });
        console.log(`Positions: ${ok}/${bars.length}`);
    }

    _resolvePosition(placementId, shapeId, length) {
        const pl = this._walkPlacement(placementId, 0);
        if (!pl) return null;
        const O = this._getMappingOffset(shapeId);
        if (!O) return null;
        const { P, R } = pl;
        const start = [
            P[0] + R[0][0]*O[0] + R[0][1]*O[1] + R[0][2]*O[2],
            P[1] + R[1][0]*O[0] + R[1][1]*O[1] + R[1][2]*O[2],
            P[2] + R[2][0]*O[0] + R[2][1]*O[1] + R[2][2]*O[2],
        ];
        const dir  = [R[0][0], R[1][0], R[2][0]];  // local X column
        const bend = [R[0][2], R[1][2], R[2][2]];  // local Z column — bend plane direction
        const end  = [start[0]+dir[0]*length, start[1]+dir[1]*length, start[2]+dir[2]*length];
        return { start, end, dir, bend };
    }

    _walkPlacement(placementId, depth) {
        if (depth > 8) return null;
        const raw = this.entities.get(placementId);
        if (!raw) return null;
        const m = raw.match(/IFCLOCALPLACEMENT\(([^,]+),\s*#(\d+)\)/);
        if (!m) return null;
        const parentRef = m[1].trim(), axis2Id = m[2];
        const local = this._parseAxis2(axis2Id);
        if (!local) return null;
        if (parentRef !== '$') {
            const parent = this._walkPlacement(parentRef.replace('#',''), depth+1);
            if (parent) {
                const rP = parent.R, lP = local.P;
                const cP = [
                    parent.P[0] + rP[0][0]*lP[0] + rP[0][1]*lP[1] + rP[0][2]*lP[2],
                    parent.P[1] + rP[1][0]*lP[0] + rP[1][1]*lP[1] + rP[1][2]*lP[2],
                    parent.P[2] + rP[2][0]*lP[0] + rP[2][1]*lP[1] + rP[2][2]*lP[2],
                ];
                return { P: cP, R: this._mulR(parent.R, local.R) };
            }
        }
        return local;
    }

    _parseAxis2(id) {
        const raw = this.entities.get(id);
        if (!raw) return null;
        const m = raw.match(/IFCAXIS2PLACEMENT3D\(\s*#(\d+),\s*(#\d+|\$),\s*(#\d+|\$)\s*\)/);
        if (!m) return null;
        const P   = this._getPoint(m[1]) || [0,0,0];
        const lZ  = m[2] !== '$' ? (this._getDir(m[2].slice(1)) || [0,0,1]) : [0,0,1];
        const lXa = m[3] !== '$' ? (this._getDir(m[3].slice(1)) || [1,0,0]) : [1,0,0];
        const dot = lXa[0]*lZ[0]+lXa[1]*lZ[1]+lXa[2]*lZ[2];
        const lX  = this._norm([lXa[0]-dot*lZ[0], lXa[1]-dot*lZ[1], lXa[2]-dot*lZ[2]]);
        const nZ  = this._norm(lZ);
        const lY  = [nZ[1]*lX[2]-nZ[2]*lX[1], nZ[2]*lX[0]-nZ[0]*lX[2], nZ[0]*lX[1]-nZ[1]*lX[0]];
        return { P, R: [[lX[0],lY[0],nZ[0]],[lX[1],lY[1],nZ[1]],[lX[2],lY[2],nZ[2]]] };
    }

    _mulR(A, B) {
        const C = [[0,0,0],[0,0,0],[0,0,0]];
        for (let i=0;i<3;i++) for (let j=0;j<3;j++) for (let k=0;k<3;k++) C[i][j]+=A[i][k]*B[k][j];
        return C;
    }

    _norm(v) {
        const l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);
        return l < 1e-12 ? [1,0,0] : [v[0]/l, v[1]/l, v[2]/l];
    }

    _getMappingOffset(shapeId) {
        const shapeDef = this.entities.get(shapeId);
        if (!shapeDef) return null;
        const repM = shapeDef.match(/\((#\d+(?:,#\d+)*)\)/);
        if (!repM) return null;
        const firstRepId = repM[1].match(/#(\d+)/)[1];
        const shapeRep = this.entities.get(firstRepId);
        if (!shapeRep || !shapeRep.includes('MappedRepresentation')) return null;
        const itemsM = shapeRep.match(/\((#\d+(?:,#\d+)*)\)\)?[;)]/);
        if (!itemsM) return null;
        const miId = itemsM[1].match(/#(\d+)/)[1];
        const mi = this.entities.get(miId);
        if (!mi) return null;
        const miM = mi.match(/IFCMAPPEDITEM\(#\d+,#(\d+)\)/);
        if (!miM) return null;
        const xform = this.entities.get(miM[1]);
        if (!xform) return null;
        const xfM = xform.match(/IFCCARTESIANTRANSFORMATIONOPERATOR3D[^(]*\([^,]*,[^,]*,\s*(#\d+|\$)/);
        if (!xfM || xfM[1] === '$') return [0, 0, 0];
        return this._getPoint(xfM[1].slice(1)) || [0, 0, 0];
    }

    _getPoint(id) {
        if (this._ptCache.has(id)) return this._ptCache.get(id);
        const raw = this.entities.get(id);
        if (!raw) return null;
        const m = raw.match(/IFCCARTESIANPOINT\(\(([^)]+)\)\)/);
        if (!m) return null;
        const pt = m[1].split(',').map(Number);
        this._ptCache.set(id, pt);
        return pt;
    }

    _getDir(id) {
        if (this._dirCache.has(id)) return this._dirCache.get(id);
        const raw = this.entities.get(id);
        if (!raw) return null;
        const m = raw.match(/IFCDIRECTION\(\(([^)]+)\)\)/);
        if (!m) return null;
        const d = m[1].split(',').map(Number);
        this._dirCache.set(id, d);
        return d;
    }

    // ── Cage-axis detection: unique perpendicular positions ratio ──────
    /**
     * For each candidate axis (X, Y, Z):
     *   Split Avonmouth mesh bars into parallel (|Dir·axis| ≥ 0.5) and
     *   perpendicular (|Dir·axis| < 0.5) groups.
     *
     *   Count unique positions in the perpendicular plane for each group,
     *   snapped to a 100 mm grid to absorb floating-point noise.
     *
     *   ratio = uniq_parallel / max(uniq_perpendicular, 1)
     *
     * Correct cage axis = axis with MAXIMUM ratio:
     *   - Longitudinal (vertical) bars fan out around the cage perimeter
     *     → HIGH unique positions when parallel to cage axis.
     *   - Ring (horizontal) bars all sit at the same transverse offsets
     *     → LOW unique positions when perpendicular to cage axis.
     *
     * This method handles cages in any global orientation, including
     * cages laid on their side where the long ring bars would incorrectly
     * win a pure "weighted total span" contest.
     */
    detectCageAxis(bars) {
        const meshBars = bars.filter(b => b.Bar_Type === 'Mesh' && b.Dir_X !== null);
        if (!meshBars.length) return;

        const axes     = [[1,0,0], [0,1,0], [0,0,1]];
        const axNames  = ['X', 'Y', 'Z'];
        const RND      = 100; // mm grid for de-duplication

        // Unique positions in the two axes perpendicular to candidate axis `ai`
        const uniqPerpPos = (blist, ai) => {
            const oi = [0,1,2].filter(j => j !== ai);
            const coords = new Set();
            blist.forEach(b => {
                const p = [b.Start_X, b.Start_Y, b.Start_Z];
                coords.add(`${Math.round(p[oi[0]]/RND)},${Math.round(p[oi[1]]/RND)}`);
            });
            return coords.size;
        };

        let bestRatio = -1;
        axes.forEach((ax, i) => {
            const par  = meshBars.filter(b => Math.abs(b.Dir_X*ax[0]+b.Dir_Y*ax[1]+b.Dir_Z*ax[2]) >= 0.5);
            const perp = meshBars.filter(b => Math.abs(b.Dir_X*ax[0]+b.Dir_Y*ax[1]+b.Dir_Z*ax[2]) <  0.5);
            const ratio = uniqPerpPos(par, i) / Math.max(uniqPerpPos(perp, i), 1);
            if (ratio > bestRatio) {
                bestRatio = ratio;
                this.cageAxis     = ax;
                this.cageAxisName = axNames[i];
            }
        });
        console.log(`Cage axis: ${this.cageAxisName} (perp-pos ratio=${bestRatio.toFixed(2)})`);
    }

    // ── Orientation tagging (global-Z rule) ───────────────────────────
    /**
     * A bar is HORIZONTAL if |Dir_Z| < 0.5 (it does not travel up/down).
     *
     * Why NOT use the cage-axis dot product:
     *   - For an upright cage (axis=Z), both rules agree: ring bars travel in X/Y.
     *   - For a sideways cage (axis=X), the structural "horizontal" bars run along
     *     the cage length (dx=1) not around it. These are parallel to the cage axis,
     *     so the old dot-product rule labelled them 'Vertical' — but they are
     *     physically horizontal (dz=0) and are what the engineer counts as horizontal.
     *
     * The global-Z rule is cage-orientation-agnostic and matches engineering intent.
     */
    tagOrientation(bars) {
        bars.forEach(bar => {
            // ATK/ICOS parity rule takes priority — works even without resolved positions.
            // (odd = horizontal, even = vertical)
            const atkOri = this._atkOrientation(bar.ATK_Layer_Name);
            if (atkOri) {
                bar.Orientation = atkOri;
                return;
            }
            // No positions resolved — cannot determine orientation geometrically.
            if (bar.Dir_X === null) { bar.Orientation = 'Unknown'; return; }
            // Fallback: global-Z heuristic — bar is horizontal if it doesn't travel up/down
            bar.Orientation = Math.abs(bar.Dir_Z) < 0.5 ? 'Horizontal' : 'Vertical';
        });
    }

    // ── ATK/ICOS orientation helper ───────────────────────────────────────
    /**
     * Returns 'Horizontal', 'Vertical', or null based on the ATK/ICOS layer name.
     *
     * ATK Rebar:  F1, F3, N1, N3 (odd)  = Horizontal
     *             F2, F4, N2, N4 (even) = Vertical
     * ICOS Rebar: FF1, FF3, NF1, NF3 (odd)  = Horizontal
     *             FF2, FF4, NF2, NF4 (even) = Vertical
     *
     * This is the authoritative orientation for mesh bars and takes precedence
     * over the global-Z heuristic for bars whose ATK/ICOS layer is known.
     */
    _atkOrientation(atkLayer) {
        if (!atkLayer) return null;
        const mATK  = atkLayer.match(/^([FN])(\d+)/i);
        if (mATK)  return parseInt(mATK[2], 10)  % 2 === 1 ? 'Horizontal' : 'Vertical';
        const mICOS = atkLayer.match(/^(FF|NF)(\d+)/i);
        if (mICOS) return parseInt(mICOS[2], 10) % 2 === 1 ? 'Horizontal' : 'Vertical';
        return null;
    }

    // ── Stagger clustering: Z-band-aware average-linkage ─────────────────
    /**
     * Groups horizontal bar IFC entities that represent the SAME structural
     * bar position into a single Stagger_Cluster_ID.
     *
     * KEY FIX: bars must first be separated into Z-bands (500 mm tolerance)
     * before clustering. Without this, bars in the bottom mesh layer and bars
     * in the top mesh layer (e.g. splice zone at different heights) get pooled
     * together and produce inflated cluster counts.
     *
     * Within each Z-band, the custom 2D distance metric applies:
     *   dPerp = perpendicular offset (along cage axis, i.e. the "spacing" direction)
     *   dZ    = height difference
     *
     *   distance(i,j) = dZ(i,j)  if dPerp(i,j) ≥ 20 mm  (lateral offset = stagger)
     *                 = +∞       if dPerp(i,j) <  20 mm  (same track → never merge)
     *
     * Average-linkage hierarchical clustering stops when avg inter-cluster dZ > 100 mm.
     */
    tagStaggerClusters(bars) {
        const DX_MIN  = 20;    // mm — minimum perpendicular offset to be a stagger candidate
        const DZ_MAX  = 100;   // mm — maximum Z difference to merge within a stagger
        const Z_BAND  = 500;   // mm — Z tolerance to define a "height zone"

        // Gather horizontal mesh bars per Effective_Mesh_Layer
        const layerBars = {};
        bars.forEach(b => {
            const layer = b.Effective_Mesh_Layer;
            if (!layer) return;
            // Use ATK/ICOS orientation if available, else global-Z heuristic
            const atkOri = this._atkOrientation(b.ATK_Layer_Name);
            const isHoriz = atkOri
                ? atkOri === 'Horizontal'
                : (b.Orientation === 'Horizontal');
            if (!isHoriz) return;
            if (!layerBars[layer]) layerBars[layer] = [];
            layerBars[layer].push(b);
        });

        Object.entries(layerBars).forEach(([layer, hbars]) => {
            if (!hbars.length) return;

            if (hbars.length === 1) {
                hbars[0].Stagger_Cluster_ID = `${layer}_H01`;
                return;
            }

            // ── Step 1: Split into Z-bands (gap-based) ───────────────────
            // A new band starts only when consecutive bar Z values differ by
            // more than Z_BAND mm.  Using a fixed gap (not a running mean)
            // avoids drift when bars are evenly spaced across a long cage.
            const zBands = [];
            const sorted = [...hbars].sort((a, b) => a.Start_Z - b.Start_Z);
            let currentBand = [sorted[0]];
            for (let si = 1; si < sorted.length; si++) {
                const gap = sorted[si].Start_Z - sorted[si - 1].Start_Z;
                if (gap > Z_BAND) {
                    zBands.push({ bars: currentBand });
                    currentBand = [sorted[si]];
                } else {
                    currentBand.push(sorted[si]);
                }
            }
            zBands.push({ bars: currentBand });

            // ── Step 2: Cluster within each Z-band ───────────────────────
            let globalClusterIdx = 0;
            const allClusters = [];

            zBands.forEach(band => {
                const zb = band.bars;
                if (zb.length === 1) {
                    allClusters.push(zb);
                    return;
                }

                const n = zb.length;

                // Perpendicular axis to cage axis — direction along which bars are spaced
                // For cage axis Z: spacing is in X or Y (we use the dominant spread axis)
                const perpAxis = (() => {
                    const spreadX = Math.max(...zb.map(b => b.Start_X)) - Math.min(...zb.map(b => b.Start_X));
                    const spreadY = Math.max(...zb.map(b => b.Start_Y)) - Math.min(...zb.map(b => b.Start_Y));
                    return spreadX >= spreadY ? 'Start_X' : 'Start_Y';
                })();

                const dist = Array.from({length: n}, (_, i) =>
                    Array.from({length: n}, (_, j) => {
                        if (i === j) return 0;
                        const dPerp = Math.abs(zb[i][perpAxis] - zb[j][perpAxis]);
                        const dZ    = Math.abs(zb[i].Start_Z   - zb[j].Start_Z);
                        return dPerp < DX_MIN ? 1e9 : dZ;
                    })
                );

                let clusters = Array.from({length: n}, (_, i) => [i]);
                while (clusters.length > 1) {
                    let minD = Infinity, mergeA = -1, mergeB = -1;
                    for (let a = 0; a < clusters.length; a++) {
                        for (let b = a + 1; b < clusters.length; b++) {
                            let sum = 0, cnt = 0;
                            for (const i of clusters[a])
                                for (const j of clusters[b]) { sum += dist[i][j]; cnt++; }
                            const avgD = sum / cnt;
                            if (avgD < minD) { minD = avgD; mergeA = a; mergeB = b; }
                        }
                    }
                    if (minD > DZ_MAX) break;
                    clusters[mergeA] = [...clusters[mergeA], ...clusters[mergeB]];
                    clusters.splice(mergeB, 1);
                }

                clusters.forEach(members => allClusters.push(members.map(i => zb[i])));
            });

            // ── Step 3: Sort all clusters by min Z, assign IDs ────────────
            allClusters.sort((a, b) =>
                Math.min(...a.map(b => b.Start_Z)) -
                Math.min(...b.map(b => b.Start_Z))
            );

            allClusters.forEach((members, ci) => {
                const id = `${layer}_H${String(ci + 1).padStart(2, '0')}`;
                members.forEach(b => { b.Stagger_Cluster_ID = id; });
            });

            console.log(`  ${layer}: ${hbars.length} entities → ${allClusters.length} stagger clusters (${zBands.length} Z-bands)`);
        });
    }

    // ── ATK fallback: Effective_Mesh_Layer ────────────────────────────
    /**
     * Infer which mesh layer a bar belongs to for stats purposes.
     *
     * Priority:
     *   1. Avonmouth_Layer_Set if it matches ^[FN]\d+A$ (primary, trusted)
     *   2. Inferred from ATK_Layer_Name IFF Avonmouth_Layer_Set is NULL
     *      (bars with any Avonmouth layer — even VS1/HS1/PRL — are NOT
     *       re-routed here, preserving correct classification)
     *
     * ATK naming convention:
     *   F1/F2 → F1A,  F3/F4 → F3A,  F5/F6 → F5A,  F7/F8 → F7A
     *   N1/N2 → N1A,  N3/N4 → N3A,  N5/N6 → N5A,  N7/N8 → N7A
     *   Odd ATK number = horizontal ring bars; Even = vertical longitudinals.
     */
    tagEffectiveMeshLayer(bars) {
        bars.forEach(bar => {
            const av = bar.Avonmouth_Layer_Set;

            // RULE: only assign a mesh layer if Avonmouth EXPLICITLY says it's mesh.
            // Unknown bars (av === null) with a recognisable ATK mesh layer name
            // (e.g. F2-CPLR → F1A) will get an Effective_Mesh_Layer here.
            // reclassifyMeshCouplers() then promotes those to Bar_Type = 'Mesh'.
            // Bars whose ATK name ends in -U or -LINK stay Unknown → C01 rejected.
            if (av && /^[FNBTfnbt]\d+A$/i.test(av)) {
                bar.Effective_Mesh_Layer = av.toUpperCase();
                return;
            }

            // ATK fallback ONLY when Avonmouth is completely absent (null).
            if (av === null || av === undefined) {
                const atk = bar.ATK_Layer_Name;
                if (atk) {
                    const isNonMesh = /[-_]U$/i.test(atk) || /[-_]LINK$/i.test(atk);
                    if (!isNonMesh) {
                        // ATK Rebar naming: F1, F2, F1-CPLR, F2-CPLR, N1, N2, etc.
                        // Odd number  = horizontal bars  → mesh layer = F<odd>A / N<odd>A
                        // Even number = vertical bars    → mesh layer = F<even-1>A / N<even-1>A
                        const mATK = atk.match(/^([FN])(\d+)/i);
                        if (mATK) {
                            const face    = mATK[1].toUpperCase();
                            const num     = parseInt(mATK[2], 10);
                            const meshNum = num % 2 === 1 ? num : num - 1;
                            bar.Effective_Mesh_Layer = `${face}${meshNum}A`;
                            return;
                        }
                        // ICOS Rebar naming: FF1, FF2, NF1, NF2, FF3, NF4, etc.
                        // Same parity rule: odd = horizontal, even = vertical
                        const mICOS = atk.match(/^(FF|NF)(\d+)/i);
                        if (mICOS) {
                            const face    = mICOS[1].charAt(0).toUpperCase(); // F or N
                            const num     = parseInt(mICOS[2], 10);
                            const meshNum = num % 2 === 1 ? num : num - 1;
                            bar.Effective_Mesh_Layer = `${face}${meshNum}A`;
                            return;
                        }
                    }
                }
            }
            bar.Effective_Mesh_Layer = null;
        });
    }

    // ── Shape Code parsing: base code + coupler suffix ────────────────
    /**
     * British Standard shape codes may be followed by Griptech coupler suffixes:
     *   GM  → Male coupler
     *   GF  → Female coupler
     *   GMB → Male Bridging coupler
     *   GFB → Female Bridging coupler
     *
     * Examples:  "00"     → base=00, no coupler
     *            "00GM"   → base=00, coupler=GM (Male)
     *            "00GMBGF"→ base=00, couplers on both ends (GMB + GF)
     *            "12LGF"  → base=12L, coupler=GF (Female)
     *
     * We store:
     *   Shape_Code_Base  — the numeric/letter part before any G suffix
     *   Coupler_Suffix   — all G-code characters after the base
     *   Coupler_Type     — human-readable description
     */
    parseShapeCodes(bars) {
        // Known coupler suffixes, longest-first so we match GMB before GM
        const SUFFIXES = [
            ['GMBGF', 'Male Bridging + Female'],
            ['GFBGM', 'Female Bridging + Male'],
            ['GMB',   'Male Bridging'],
            ['GFB',   'Female Bridging'],
            ['GM',    'Male'],
            ['GF',    'Female'],
        ];

        bars.forEach(bar => {
            const raw = (bar.Shape_Code || '').trim().toUpperCase();
            if (!raw) return;

            // Find coupler suffix: scan for the first 'G' that starts a known suffix
            let base = raw, suffix = '', couplerType = null;
            for (const [sfx, label] of SUFFIXES) {
                const idx = raw.indexOf(sfx);
                if (idx !== -1) {
                    base        = raw.slice(0, idx);
                    suffix      = raw.slice(idx);
                    couplerType = label;
                    break;
                }
            }
            bar.Shape_Code_Base = base || raw;
            bar.Coupler_Suffix  = suffix || null;
            bar.Coupler_Type    = couplerType;
        });
    }

    // ── Weight / classify / shape ──────────────────────────────────────

    calculateWeights(bars) {
        const RHO = 7777; // kg/m³ steel density
        bars.forEach(bar => {
            // ALWAYS compute formula weight from geometry — stored as bar.Formula_Weight.
            // This is the ONLY value used for UDL (nonMeshFormulaW / meshFormulaW).
            // It is NOT used for cage weight totals, layer weight table, or bar stats.
            const size = bar.Size || bar.NominalDiameter_mm;
            const len  = bar.Length;
            if (size && len) {
                const r = (size / 1000) / 2, l = len / 1000;
                bar.Formula_Weight    = parseFloat((Math.PI * r * r * l * RHO).toFixed(3));
                bar.Calculated_Weight = bar.Formula_Weight; // keep for legacy CSV export
            }

            // bar.Weight = ATK Rebar or ICOS Rebar 'Weight' pset field ONLY.
            // Already extracted by extractProperties into bar.Weight (never overwritten here).
            // If ATK/ICOS weight is absent, bar.Weight stays null — flagged as missingWeightCount.
        });
    }


    /**
     * Second-pass reclassification for bars that:
     *   1. Have no Avonmouth Layer/Set (Avonmouth_Layer_Set === null)
     *   2. BUT have a valid Effective_Mesh_Layer inferred from their ATK Layer Name
     *      (e.g. ATK "F2-CPLR" → Effective_Mesh_Layer "F1A")
     *
     * These are vertical coupler connector bars in the mesh cage.  The Avonmouth
     * property set is simply missing from their IFC export — they are genuine mesh
     * members and must be counted as Mesh for weight, height, and dimension stats.
     *
     * -U and -LINK bars are excluded by tagEffectiveMeshLayer (Effective_Mesh_Layer
     * stays null for them) so they remain Unknown and still trigger C01 rejection.
     *
     * Must run AFTER tagEffectiveMeshLayer() and BEFORE tagStaggerClusters().
     */
    reclassifyMeshCouplers(bars) {
        bars.forEach(bar => {
            if (bar.Bar_Type === 'Unknown' &&
                bar.Avonmouth_Layer_Set === null &&
                bar.Effective_Mesh_Layer !== null) {
                bar.Bar_Type = 'Mesh';
                // Tag so the data table can show the source of the classification
                bar.Mesh_Source = 'ATK-inferred';
            }
        });
    }

    classifyBars(bars) {
        bars.forEach(bar => {
            const layer = bar.Avonmouth_Layer_Set || '';
            if (!layer)                                  bar.Bar_Type = 'Unknown';
            else if (/^[FNBTfnbt]\d+A$/i.test(layer))  bar.Bar_Type = 'Mesh'; // F/N/B/T face layers
            else if (/^LB\d*$/i.test(layer))            bar.Bar_Type = 'Loose Bar';
            else if (/^LK\d*$/i.test(layer))            bar.Bar_Type = 'Link Bar';
            else if (/^[VH]S\d*$/i.test(layer))         bar.Bar_Type = 'Strut Bar';
            else if (/^PR[LC]\d*$/i.test(layer))       bar.Bar_Type = 'Preload Bar'; // PRL and PRC family
            else if (/^S\d*$/i.test(layer))             bar.Bar_Type = 'Site Bar';
            else                                         bar.Bar_Type = 'Other';
        });
    }

    detectBarShapes(bars) {
        bars.forEach(bar => {
            const n = (bar.Name || '').toUpperCase();
            if      (n.includes('CPLR')) bar.Bar_Shape = 'Straight with Coupler';
            else if (n.includes('LINK')) bar.Bar_Shape = 'L-Bar';
            else                         bar.Bar_Shape = 'Straight';
        });
    }

    // ── Rejection status ──────────────────────────────────────────────
    /**
     * Rejection conditions:
     *   1. Unknown bars  — bars with no Avonmouth "Layer/Set" property at all
     *      (Avonmouth_Layer_Set === null). Indicates missing/wrong IFC data.
     *   2. Duplicate GlobalIds — same bar represented more than once.
     *
     * When any condition is true: isRejected = true.
     * The analysis still runs and displays so the engineer can see what is wrong.
     */
    computeRejectionStatus(bars) {
        // Unknown bar type: bars with Bar_Type === 'Unknown'
        this.unknownCount = bars.filter(b => b.Bar_Type === 'Unknown').length;
        this.unknownBars  = bars.filter(b => b.Bar_Type === 'Unknown');

        // Missing Avonmouth layer: bars with no Avonmouth_Layer_Set regardless of Bar_Type.
        // Even ATK-inferred Mesh bars without an Avonmouth pset are flagged — the IFC
        // is incomplete and the cage must be rejected until the data gap is resolved.
        this.missingLayerBars  = bars.filter(b => !b.Avonmouth_Layer_Set);
        this.missingLayerCount = this.missingLayerBars.length;

        // Duplicates: any GlobalId appearing more than once
        const seen = new Map();
        bars.forEach(b => seen.set(b.GlobalId, (seen.get(b.GlobalId) || 0) + 1));
        this.duplicateCount = [...seen.values()].filter(c => c > 1).length;
        this.duplicateGuids = [...seen.entries()].filter(([, c]) => c > 1).map(([g]) => g);
        this.duplicateBars  = bars.filter(b => (seen.get(b.GlobalId) || 0) > 1);

        // Missing ATK/ICOS Weight: bars that have no Weight from ATK Rebar or ICOS Rebar psets.
        // bar.Weight is set ONLY by extractProperties from ATK/ICOS psets — never from formula.
        // Formula_Weight is always computed separately and does NOT affect this flag.
        this.missingWeightBars  = bars.filter(b =>
            b.Weight === null || b.Weight === undefined
        );
        this.missingWeightCount = this.missingWeightBars.length;

        this.isRejected = this.unknownCount      > 0 ||
                          this.missingLayerCount  > 0 ||
                          this.duplicateCount     > 0 ||
                          this.missingWeightCount > 0;
    }
}

// ── Layer stats extraction for checker ───────────────────────────────
const _MESH_LAYER_SET      = new Set(['F1A','F3A','F5A','F7A','N1A','N3A','N5A','N7A']);
const _NON_MESH_PREFIXES   = ['VS','HS','LK','LB'];
const _NON_MESH_EXACT      = new Set(['PRL','PRC']);
function _isNonMeshLayer(name) {
    if (!name) return false;
    if (_NON_MESH_EXACT.has(name)) return true;
    return _NON_MESH_PREFIXES.some(p => name.startsWith(p));
}

IFCParser.prototype.extractCheckerData = function(bars) {
    const result = {};
    const byLayer = {};
    bars.forEach(bar => {
        const layer = bar.Effective_Mesh_Layer;
        if (!layer) return;
        if (!byLayer[layer]) byLayer[layer] = { hori: [], vert: [] };
        if (bar.Orientation === 'Horizontal') byLayer[layer].hori.push(bar);
        else if (bar.Orientation === 'Vertical') byLayer[layer].vert.push(bar);
    });

    for (const [layer, data] of Object.entries(byLayer)) {
        const hDias   = data.hori.map(b => b.Size || b.NominalDiameter_mm).filter(Boolean);
        const vDias   = data.vert.map(b => b.Size || b.NominalDiameter_mm).filter(Boolean);
        const heights = data.vert.map(b => b.Length).filter(Boolean);
        const clusters = new Set(data.hori.map(b => b.Stagger_Cluster_ID).filter(Boolean));
        const count = clusters.size || (data.hori.length || null);
        result[layer] = {
            hori: {
                minDia: hDias.length   ? Math.min(...hDias)  : null,
                maxDia: hDias.length   ? Math.max(...hDias)  : null,
                count : count,
            },
            vert: {
                minDia: vDias.length   ? Math.min(...vDias)  : null,
                maxDia: vDias.length   ? Math.max(...vDias)  : null,
                height: heights.length ? +(Math.max(...heights) / 1000).toFixed(3) : null,
            },
        };
    }

    // ── UDL Factor ─────────────────────────────────────────────────────────
    // UDL = nonMeshFormulaWeight / meshFormulaWeight (geometry-based weights)
    let meshFW = 0, nonMeshFW = 0;
    bars.forEach(bar => {
        const fw    = bar.Formula_Weight || 0;
        const layer = bar.Avonmouth_Layer_Set;
        if (_MESH_LAYER_SET.has(layer))      meshFW    += fw;
        else if (_isNonMeshLayer(layer))     nonMeshFW += fw;
    });
    const udl = meshFW > 0 ? +(nonMeshFW / meshFW).toFixed(4) : null;

    // ── Wall Width ─────────────────────────────────────────────────────────
    // Mirrors avonmouth-cage-v2 logic:
    //   1. Smallest coordinate spread of ALL bars (mm) = cage outer-to-outer width.
    //   2. Add 100 mm cover on each side → raw wall thickness.
    //   3. Round UP to nearest standard wall thickness.
    // Standard thicknesses (matching cage-v2 roundWallThicknessM):
    const _WALL_STD_MM = [300, 500, 800, 1100, 1500, 2600];
    const xs = [], ys = [], zs = [];
    bars.forEach(bar => {
        if (bar.Start_X != null) { xs.push(bar.Start_X, bar.End_X); }
        if (bar.Start_Y != null) { ys.push(bar.Start_Y, bar.End_Y); }
        if (bar.Start_Z != null) { zs.push(bar.Start_Z, bar.End_Z); }
    });
    const _spread = arr => arr.length ? Math.max(...arr) - Math.min(...arr) : 0;
    const spreads = [_spread(xs), _spread(ys), _spread(zs)].filter(s => s > 10).sort((a,b) => a-b);
    let wallWidth = null;
    if (spreads.length > 0) {
        const overallWidthMm = spreads[0];
        const rawMm = overallWidthMm + 100;
        const stdMm = _WALL_STD_MM.find(v => v >= rawMm) || 2600;
        wallWidth = +(stdMm / 1000).toFixed(3);
    }

    return {
        checkerLayers : result,
        udl           : udl,
        wallWidth     : wallWidth,
        c01Rejected   : this.isRejected,
        unknownCount  : this.unknownCount,
        duplicateCount: this.duplicateCount,
        totalBars     : bars.length,
    };
};

module.exports = IFCParser;
