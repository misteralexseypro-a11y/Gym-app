// Чистая логика без DOM: подключается в index.html и тестируется в node (tests/core.test.js).
(function (root) {
    'use strict';

    const SCHEMA_VERSION = 3;

    function toDateKey(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function shiftDateKey(dateKey, deltaDays) {
        const [y, m, d] = dateKey.split('-').map(Number);
        return toDateKey(new Date(y, m - 1, d + deltaDays));
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const num = (v, fallback = 0) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };
    // ID попадают в onclick-атрибуты, поэтому допускаем только безопасные символы.
    const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
    const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

    function sanitizeText(v, max = 120) {
        return String(v == null ? '' : v).slice(0, max);
    }

    function sanitizeFood(f) {
        if (!isObj(f)) return null;
        return {
            uid: num(f.uid, Date.now() + Math.random()),
            name: sanitizeText(f.name),
            cal: num(f.cal), p: num(f.p), f: num(f.f), c: num(f.c),
            time: sanitizeText(f.time, 8)
        };
    }

    function sanitizeSets(sets) {
        if (!Array.isArray(sets)) return [];
        return sets.filter(isObj).map(s => ({ weight: num(s.weight), reps: num(s.reps) }));
    }

    /**
     * Приводит произвольный объект (localStorage или бэкап) к валидной схеме.
     * Бросает Error, если это вообще не состояние приложения.
     */
    function migrateState(raw, defaults) {
        if (!isObj(raw)) throw new Error('Состояние не является объектом');
        const looksLikeState = ['weightLogs', 'workoutHistory', 'dailyRecords', 'foodDatabase'].some(k => k in raw);
        if (!looksLikeState) throw new Error('Нет ни одного раздела данных приложения');

        const s = { ...defaults };

        if (['workout', 'food', 'progress'].includes(raw.currentTab)) s.currentTab = raw.currentTab;
        if (['d1', 'd2', 'd3'].includes(raw.workoutDay)) s.workoutDay = raw.workoutDay;
        if (['start', 'target'].includes(raw.workoutPhase)) s.workoutPhase = raw.workoutPhase;
        if (typeof raw.d2Ex1Variant === 'string' && SAFE_ID.test(raw.d2Ex1Variant)) s.d2Ex1Variant = raw.d2Ex1Variant;
        if (typeof raw.d3Ex2Variant === 'string' && SAFE_ID.test(raw.d3Ex2Variant)) s.d3Ex2Variant = raw.d3Ex2Variant;
        s.manualQueueNext = ['d1', 'd2', 'd3'].includes(raw.manualQueueNext) ? raw.manualQueueNext : null;

        s.exerciseNotes = {};
        if (isObj(raw.exerciseNotes)) {
            for (const [k, v] of Object.entries(raw.exerciseNotes)) {
                if (SAFE_ID.test(k)) s.exerciseNotes[k] = sanitizeText(v, 200);
            }
        }

        s.dailyRecords = {};
        if (isObj(raw.dailyRecords)) {
            for (const [date, r] of Object.entries(raw.dailyRecords)) {
                if (!DATE_KEY.test(date) || !isObj(r)) continue;
                const mode = ['d1', 'd2', 'd3', 'rest'].includes(r.mode) ? r.mode : 'rest';
                const warm = Array.isArray(r.warmup) ? r.warmup : [];
                s.dailyRecords[date] = {
                    mode,
                    cns: Math.min(10, Math.max(1, Math.round(num(r.cns, 8)))),
                    foods: Array.isArray(r.foods) ? r.foods.map(sanitizeFood).filter(Boolean) : [],
                    warmup: [!!warm[0], !!warm[1]]
                };
            }
        }

        s.activeSessionSets = {};
        if (isObj(raw.activeSessionSets)) {
            for (const [k, sets] of Object.entries(raw.activeSessionSets)) {
                if (!SAFE_ID.test(k) || !Array.isArray(sets)) continue;
                s.activeSessionSets[k] = sets.filter(isObj).map(x => ({ weight: num(x.weight), reps: num(x.reps), done: !!x.done }));
            }
        }

        const rirMap = (m) => {
            const out = {};
            if (isObj(m)) for (const [k, v] of Object.entries(m)) {
                if (SAFE_ID.test(k) && [0, 1, 2, 3].includes(v)) out[k] = v;
            }
            return out;
        };
        const flagMap = (m) => {
            const out = {};
            if (isObj(m)) for (const [k, v] of Object.entries(m)) if (SAFE_ID.test(k) && v) out[k] = true;
            return out;
        };
        s.sessionRir = rirMap(raw.sessionRir);
        s.sessionDeload = flagMap(raw.sessionDeload);
        s.plateauDismissed = {};
        if (isObj(raw.plateauDismissed)) {
            for (const [k, v] of Object.entries(raw.plateauDismissed)) if (SAFE_ID.test(k)) s.plateauDismissed[k] = num(v);
        }

        s.workoutHistory = [];
        const seenIds = new Set();
        if (Array.isArray(raw.workoutHistory)) {
            for (const w of raw.workoutHistory) {
                if (!isObj(w) || !['d1', 'd2', 'd3'].includes(w.dayId)) continue;
                let id = Math.round(num(w.id, 0));
                while (!id || seenIds.has(id)) id = Date.now() + Math.floor(Math.random() * 1e6);
                seenIds.add(id);
                const exercises = {};
                let setsDone = 0;
                if (isObj(w.exercises)) {
                    for (const [exId, sets] of Object.entries(w.exercises)) {
                        if (!SAFE_ID.test(exId)) continue;
                        const clean = sanitizeSets(sets);
                        if (clean.length) { exercises[exId] = clean; setsDone += clean.length; }
                    }
                }
                s.workoutHistory.push({
                    id,
                    date: DATE_KEY.test(w.date) ? w.date : toDateKey(new Date()),
                    dayId: w.dayId,
                    dayName: sanitizeText(w.dayName),
                    phase: w.phase === 'target' ? 'target' : 'start',
                    setsDone,
                    exercises,
                    rir: rirMap(w.rir),
                    deload: flagMap(w.deload)
                });
            }
        }

        if (Array.isArray(raw.weightLogs)) {
            const logs = raw.weightLogs
                .filter(x => isObj(x) && DATE_KEY.test(x.date) && num(x.weight) > 0)
                .map(x => ({ date: x.date, weight: num(x.weight) }));
            if (logs.length) s.weightLogs = logs.sort((a, b) => a.date.localeCompare(b.date));
        }

        if (Array.isArray(raw.foodDatabase)) {
            const usedIds = new Set();
            const db = raw.foodDatabase.filter(isObj).map((f, i) => {
                let id = typeof f.id === 'string' && SAFE_ID.test(f.id) ? f.id : `cust_${Date.now()}_${i}`;
                if (usedIds.has(id)) id = `${id}_${i}`;
                usedIds.add(id);
                return { id, name: sanitizeText(f.name), cal: num(f.cal), p: num(f.p), f: num(f.f), c: num(f.c), pinned: !!f.pinned };
            });
            if (db.length) s.foodDatabase = db;
        }

        s.workoutsSinceLastBackup = Math.max(0, Math.round(num(raw.workoutsSinceLastBackup)));
        s.lastBackupDate = typeof raw.lastBackupDate === 'string' && DATE_KEY.test(raw.lastBackupDate) ? raw.lastBackupDate : null;

        s.editing = null;
        if (isObj(raw.editing) && s.workoutHistory.some(w => w.id === raw.editing.workoutId)) {
            const b = isObj(raw.editing.backup) ? raw.editing.backup : {};
            const backup = migrateState({ workoutHistory: [], ...b }, defaults);
            s.editing = {
                workoutId: raw.editing.workoutId,
                backup: {
                    activeSessionSets: backup.activeSessionSets,
                    sessionRir: backup.sessionRir,
                    sessionDeload: backup.sessionDeload,
                    workoutDay: backup.workoutDay,
                    workoutPhase: backup.workoutPhase,
                    d2Ex1Variant: backup.d2Ex1Variant,
                    d3Ex2Variant: backup.d3Ex2Variant
                }
            };
        }

        s.schemaVersion = SCHEMA_VERSION;
        return s;
    }

    // ---------- Бэкап: base64 через TextEncoder вместо устаревших escape/unescape ----------
    const BACKUP_PREFIX = 'TACTICAL_BACKUP_';

    function encodeBackup(state) {
        const bytes = new TextEncoder().encode(JSON.stringify(state));
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return BACKUP_PREFIX + btoa(bin);
    }

    function decodeBackup(code) {
        const clean = String(code).trim().replace(/^TACTICAL_BACKUP_/, '').replace(/\s+/g, '');
        const bin = atob(clean);
        const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
    }

    // ---------- Прогрессия ----------
    // loadType: external — обычный вес; assist — противовес гравитрона (меньше = тяжелее);
    // bodyweight — растут повторы; time — секунды (планка).
    function setLoad(set, loadType) {
        if (loadType === 'external') return num(set.weight);
        if (loadType === 'assist') return -num(set.weight);
        return 0;
    }

    /** Оценка одной записи упражнения относительно плана фазы, в которой она выполнялась. */
    function assessEntry(entry, plan) {
        const sets = entry.sets || [];
        const allPlannedDone = sets.length >= plan.sets;
        const allAtTop = sets.length > 0 && sets.every(s => num(s.reps) >= plan.maxReps);
        if (allPlannedDone && allAtTop) {
            const light = entry.rir != null && entry.rir >= 2;
            return { status: 'grow', light };
        }
        return { status: 'build' };
    }

    /** true, если cur продвинулся относительно prev хотя бы в одном подходе. */
    function isProgress(prev, cur, loadType) {
        const p = prev.sets || [], c = cur.sets || [];
        for (let i = 0; i < c.length; i++) {
            if (!p[i]) return true; // подход добавлен
            const lc = setLoad(c[i], loadType), lp = setLoad(p[i], loadType);
            if (lc > lp) return true;
            if (lc === lp && num(c[i].reps) > num(p[i].reps)) return true;
        }
        const same = c.length === p.length && c.every((s, i) =>
            setLoad(s, loadType) === setLoad(p[i], loadType) && num(s.reps) === num(p[i].reps));
        if (same && cur.rir != null && prev.rir != null && cur.rir > prev.rir) return true;
        return false;
    }

    /**
     * Плато: две тренировки подряд без прогресса (нужно ≥3 записей).
     * Разгрузочная запись обнуляет отсчёт.
     */
    function detectPlateau(entries, loadType) {
        const n = entries.length;
        if (n < 3) return false;
        const [a, b, c] = entries.slice(-3);
        if (b.deload || c.deload) return false;
        return !isProgress(a, b, loadType) && !isProgress(b, c, loadType);
    }

    function roundTo(value, step) {
        return Math.round(value / step) * step;
    }

    /** Вес для разгрузки −10% (для гравитрона — добавить 10% эффективной нагрузки к противовесу). */
    function deloadWeight(weight, loadType, bodyWeight) {
        const w = num(weight);
        if (loadType === 'external') {
            if (w <= 0) return 0;
            let next = roundTo(w * 0.9, 0.5);
            if (next >= w) next = Math.max(0, w - 0.5);
            return +next.toFixed(2);
        }
        if (loadType === 'assist') {
            const effective = Math.max(0, num(bodyWeight) - w);
            let next = roundTo(w + effective * 0.1, 0.5);
            if (next <= w) next = w + 0.5;
            return +next.toFixed(2);
        }
        return w;
    }

    function grownWeight(weight, loadType, increment) {
        const w = num(weight);
        if (loadType === 'external') return +(w + increment).toFixed(2);
        if (loadType === 'assist') return Math.max(0, +(w - increment).toFixed(2));
        return w;
    }

    // ---------- Сила ----------
    function epley(load, reps) {
        if (load <= 0 || reps <= 0) return 0;
        return reps === 1 ? load : load * (1 + reps / 30);
    }

    /**
     * Метрики одной записи для графика. RIR относится к финальному подходу
     * и добавляется к его повторам при расчёте e1RM.
     */
    function strengthPoint(entry, loadType, bodyWeight) {
        const sets = entry.sets || [];
        const last = sets.length - 1;
        const rir = entry.rir != null ? entry.rir : 0;
        let best = 0, topWeight = null, bestReps = 0, totalReps = 0;
        sets.forEach((s, i) => {
            const reps = num(s.reps);
            totalReps += reps;
            bestReps = Math.max(bestReps, reps);
            const effReps = reps + (i === last ? rir : 0);
            let load = 0;
            if (loadType === 'external') load = num(s.weight);
            else if (loadType === 'assist') load = Math.max(0, num(bodyWeight) - num(s.weight));
            if (load > 0) best = Math.max(best, epley(load, effReps));
            if (loadType === 'external') topWeight = topWeight == null ? num(s.weight) : Math.max(topWeight, num(s.weight));
            if (loadType === 'assist') topWeight = topWeight == null ? num(s.weight) : Math.min(topWeight, num(s.weight));
        });
        return { e1rm: +best.toFixed(1), topWeight, bestReps, totalReps };
    }

    // ---------- Питание ----------
    /** Среднее КБЖУ за 7 полных дней до todayKey (сегодня не входит): сумма / 7. */
    function weeklyNutrition(dailyRecords, todayKey) {
        const days = [];
        const sum = { cal: 0, p: 0, f: 0, c: 0 };
        let filled = 0;
        for (let i = 1; i <= 7; i++) {
            const key = shiftDateKey(todayKey, -i);
            const rec = dailyRecords[key];
            const day = { date: key, cal: 0, p: 0, f: 0, c: 0, filled: false };
            if (rec && Array.isArray(rec.foods) && rec.foods.length) {
                day.filled = true;
                filled++;
                rec.foods.forEach(x => { day.cal += num(x.cal); day.p += num(x.p); day.f += num(x.f); day.c += num(x.c); });
            }
            sum.cal += day.cal; sum.p += day.p; sum.f += day.f; sum.c += day.c;
            days.push(day);
        }
        return {
            days,
            filled,
            avg: { cal: Math.round(sum.cal / 7), p: Math.round(sum.p / 7), f: Math.round(sum.f / 7), c: Math.round(sum.c / 7) }
        };
    }

    const api = {
        SCHEMA_VERSION, toDateKey, shiftDateKey, escapeHtml, migrateState,
        encodeBackup, decodeBackup, assessEntry, isProgress, detectPlateau,
        deloadWeight, grownWeight, epley, strengthPoint, weeklyNutrition
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TacticalCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
