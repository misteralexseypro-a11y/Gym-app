// Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const DEFAULTS = () => ({
    currentTab: 'workout', workoutDay: 'd1', workoutPhase: 'start',
    d2Ex1Variant: 'pullups', d3Ex2Variant: 'legpress', manualQueueNext: null,
    exerciseNotes: {}, dailyRecords: {}, activeSessionSets: {}, workoutHistory: [],
    weightLogs: [{ date: '2026-01-01', weight: 79.6 }], foodDatabase: [{ id: 'f_x', name: 'X', cal: 1, p: 1, f: 1, c: 1, pinned: true }],
    workoutsSinceLastBackup: 0, lastBackupDate: null
});

const plan = { sets: 3, minReps: 8, maxReps: 10 };
const e = (sets, extra = {}) => ({ sets: sets.map(([weight, reps]) => ({ weight, reps })), ...extra });

test('ложная готовность: один подход 10/10 из трёх — не рост', () => {
    assert.equal(C.assessEntry(e([[50, 10]]), plan).status, 'build');
    assert.equal(C.assessEntry(e([[50, 10], [50, 10], [50, 9]]), plan).status, 'build');
    assert.equal(C.assessEntry(e([[50, 10], [50, 10], [50, 10]]), plan).status, 'grow');
});

test('вариант А: RIR 0–1 обычный рост, RIR 2–3 рост с пометкой «лёгкий»', () => {
    const all = [[50, 10], [50, 10], [50, 10]];
    assert.deepEqual(C.assessEntry(e(all, { rir: 0 }), plan), { status: 'grow', light: false });
    assert.deepEqual(C.assessEntry(e(all, { rir: 1 }), plan), { status: 'grow', light: false });
    assert.deepEqual(C.assessEntry(e(all, { rir: 3 }), plan), { status: 'grow', light: true });
    assert.deepEqual(C.assessEntry(e(all), plan), { status: 'grow', light: false });
});

test('прогресс: рост веса, +повтор хотя бы в одном подходе, рост RIR при равных цифрах', () => {
    const base = e([[50, 9], [50, 9], [50, 8]], { rir: 1 });
    assert.equal(C.isProgress(base, e([[52.5, 8], [52.5, 8], [52.5, 8]]), 'external'), true);
    assert.equal(C.isProgress(base, e([[50, 9], [50, 9], [50, 9]]), 'external'), true);
    assert.equal(C.isProgress(base, e([[50, 9], [50, 9], [50, 8]], { rir: 2 }), 'external'), true);
    assert.equal(C.isProgress(base, e([[50, 9], [50, 9], [50, 8]], { rir: 1 }), 'external'), false);
    assert.equal(C.isProgress(base, e([[50, 9], [50, 8]]), 'external'), false);
    assert.equal(C.isProgress(base, e([[47.5, 10], [47.5, 10], [47.5, 10]]), 'external'), false);
});

test('гравитрон: меньший противовес — это прогресс', () => {
    assert.equal(C.isProgress(e([[20, 8]]), e([[17.5, 8]]), 'assist'), true);
    assert.equal(C.isProgress(e([[20, 8]]), e([[22.5, 8]]), 'assist'), false);
});

test('плато: две тренировки подряд без прогресса; накопление повторов — не плато', () => {
    const s = (r) => e([[50, r[0]], [50, r[1]], [50, r[2]]]);
    assert.equal(C.detectPlateau([s([8, 8, 8]), s([9, 8, 8]), s([9, 9, 8])], 'external'), false);
    assert.equal(C.detectPlateau([s([9, 9, 8]), s([9, 9, 8]), s([9, 8, 8])], 'external'), true);
    assert.equal(C.detectPlateau([s([9, 9, 8]), s([9, 9, 8])], 'external'), false);
    // разгрузка сбрасывает отсчёт
    assert.equal(C.detectPlateau([s([9, 9, 8]), s([9, 9, 8]), { ...s([9, 9, 8]), deload: true }], 'external'), false);
});

test('разгрузка −10% и шаг роста', () => {
    assert.equal(C.deloadWeight(50, 'external'), 45);
    assert.equal(C.deloadWeight(7, 'external'), 6.5);
    assert.equal(C.deloadWeight(2.5, 'external'), 2);
    assert.equal(C.deloadWeight(20, 'assist', 80), 26); // 20 + 10% от (80-20)
    assert.equal(C.grownWeight(50, 'external', 2.5), 52.5);
    assert.equal(C.grownWeight(2, 'assist', 5), 0);
});

test('e1RM учитывает RIR финального подхода', () => {
    const p = C.strengthPoint(e([[100, 5], [100, 5]], { rir: 1 }), 'external');
    assert.equal(p.e1rm, +(100 * (1 + 6 / 30)).toFixed(1));
    assert.equal(p.topWeight, 100);
    const a = C.strengthPoint(e([[20, 8]]), 'assist', 80);
    assert.equal(a.e1rm, +(60 * (1 + 8 / 30)).toFixed(1));
});

test('среднее КБЖУ: сумма за 7 полных дней / 7, сегодня не входит', () => {
    const rec = (cal, p) => ({ mode: 'rest', foods: [{ cal, p, f: 0, c: 0 }] });
    const daily = {
        '2026-11-10': rec(9999, 999), // сегодня — игнор
        '2026-11-09': rec(2100, 140),
        '2026-11-07': rec(1400, 70),
        '2026-11-03': rec(700, 0),
        '2026-11-02': rec(5000, 0) // 8-й день — вне окна
    };
    const r = C.weeklyNutrition(daily, '2026-11-10');
    assert.equal(r.filled, 3);
    assert.equal(r.avg.cal, 600);
    assert.equal(r.avg.p, 30);
    assert.equal(r.days[0].date, '2026-11-09');
    assert.equal(r.days[6].date, '2026-11-03');
});

test('shiftDateKey переходит через границу месяца', () => {
    assert.equal(C.shiftDateKey('2026-03-01', -1), '2026-02-28');
});

test('бэкап: кириллица переживает кодирование', () => {
    const state = { weightLogs: [{ date: '2026-01-01', weight: 80 }], note: 'Жим 30° ✓' };
    assert.deepEqual(C.decodeBackup(C.encodeBackup(state)), state);
    assert.deepEqual(C.decodeBackup('  ' + C.encodeBackup(state) + '\n'), state);
});

test('миграция: мусор отвергается, битые поля чинятся', () => {
    assert.throws(() => C.migrateState(null, DEFAULTS()));
    assert.throws(() => C.migrateState({ foo: 1 }, DEFAULTS()));
    const s = C.migrateState({ weightLogs: [{ date: '2026-02-01', weight: 78 }], dailyRecords: null, workoutHistory: 'x' }, DEFAULTS());
    assert.deepEqual(s.dailyRecords, {});
    assert.deepEqual(s.workoutHistory, []);
    assert.equal(s.weightLogs[0].weight, 78);
    assert.equal(s.schemaVersion, C.SCHEMA_VERSION);
    assert.equal(s.foodDatabase.length, 1);
});

test('миграция: опасные ID и строки не проходят', () => {
    const s = C.migrateState({
        foodDatabase: [{ id: "x');alert(1);('", name: '<img src=x onerror=alert(1)>', cal: 10, p: 1, f: 1, c: 1 }],
        workoutHistory: [{ id: '1)alert(1', dayId: 'd1', date: '2026-01-01', exercises: { "bad'id": [{ weight: 1, reps: 1 }], d1_ex2: [{ weight: '50', reps: 10 }] } }]
    }, DEFAULTS());
    assert.match(s.foodDatabase[0].id, /^[A-Za-z0-9_-]+$/);
    assert.equal(typeof s.workoutHistory[0].id, 'number');
    assert.deepEqual(Object.keys(s.workoutHistory[0].exercises), ['d1_ex2']);
    assert.equal(s.workoutHistory[0].exercises.d1_ex2[0].weight, 50);
    assert.equal(s.workoutHistory[0].setsDone, 1);
    assert.equal(C.escapeHtml(s.foodDatabase[0].name), '&lt;img src=x onerror=alert(1)&gt;');
});
