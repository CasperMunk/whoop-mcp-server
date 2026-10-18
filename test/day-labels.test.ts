import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WhoopDatabase } from '../src/database.js';
import { buildFixture, nights } from './fixture.js';

// Look back far enough to include the fixture week whenever the tests run.
const DAYS = Math.ceil((Date.now() - Date.parse('2026-10-09')) / 86_400_000);

const expectedDays = nights.map(n => n.day);
const byDay = <T extends { date: string }>(rows: T[]): Map<string, T> => new Map(rows.map(r => [r.date, r]));

function load(opts: { withOffsets: boolean; withSleepCycleId: boolean }): WhoopDatabase {
	const db = new WhoopDatabase(':memory:');
	const f = buildFixture(opts);
	db.upsertCycles(f.cycles);
	db.upsertRecoveries(f.recoveries);
	db.upsertSleeps(f.sleeps);
	db.upsertWorkouts(f.workouts);
	return db;
}

const variants = [
	{ name: 'fresh sync (offsets and sleep.cycle_id stored)', opts: { withOffsets: true, withSleepCycleId: true } },
	{ name: 'rows synced before this fix (no offsets, no sleep.cycle_id)', opts: { withOffsets: false, withSleepCycleId: false } },
];

for (const { name, opts } of variants) {
	describe(name, () => {
		const db = load(opts);

		test('strain history has exactly one row per local day, labelled as in the Whoop app', () => {
			const rows = db.getStrainTrends(DAYS);
			assert.deepEqual(rows.map(r => r.date).sort(), [...expectedDays].sort());
			const strain = byDay(rows);
			for (const n of nights) assert.equal(strain.get(n.day)?.strain, n.strain, n.day);
		});

		test('sleep analysis labels each night by the morning it ended', () => {
			const rows = db.getSleepTrends(DAYS);
			assert.deepEqual(rows.map(r => r.date).sort(), [...expectedDays].sort());
			const sleep = byDay(rows);
			// Wed 14 bedtime 22:30, 8h 48m: belongs to Thu 15, not Wed 14
			assert.equal(sleep.get('2026-10-15')?.total_sleep_hours, 8.8);
			// Thu 15 bedtime 23:00, 8h 10m: belongs to Fri 16
			assert.equal(sleep.get('2026-10-16')?.total_sleep_hours, 8.17);
			// Mon 00:40 bedtime, 4h 3m: belongs to Mon 12
			assert.equal(sleep.get('2026-10-12')?.total_sleep_hours, 4.05);
		});

		test('sleep debt uses the same labels', () => {
			const rows = db.getSleepDebtTrend(DAYS);
			assert.deepEqual(rows.map(r => r.date).sort(), [...expectedDays].sort());
		});

		test('recovery, sleep and strain dates agree', () => {
			const rec = byDay(db.getRecoveryTrends(DAYS));
			const strain = byDay(db.getStrainTrends(DAYS));
			const sleep = byDay(db.getSleepTrends(DAYS));
			assert.deepEqual([...rec.keys()].sort(), [...strain.keys()].sort());
			assert.deepEqual([...sleep.keys()].sort(), [...strain.keys()].sort());
			for (const n of nights) assert.equal(rec.get(n.day)?.recovery_score, n.recovery, n.day);
		});

		test('training load attaches workouts to the cycle they happened in', () => {
			const rows = byDay(db.getDailyTrainingLoad(DAYS));
			assert.equal(rows.size, nights.length);
			assert.equal(rows.get('2026-10-15')?.workout_count, 1);
			assert.equal(rows.get('2026-10-15')?.sports, 'activity');
			assert.equal(rows.get('2026-10-12')?.sports, 'functional-fitness');
			assert.equal(rows.get('2026-10-11')?.sports, 'volleyball');
			assert.equal(rows.get('2026-10-16')?.workout_count, 0);
			assert.equal(rows.get('2026-10-14')?.workout_count, 0);
		});

		test('day strain is never below the strain of a workout inside it', () => {
			const rows = byDay(db.getDailyTrainingLoad(DAYS));
			const workouts = db.getWorkouts(DAYS);
			const strainOf: Record<string, number> = { activity: 10.47, 'functional-fitness': 6.52, volleyball: 10.98 };
			assert.equal(workouts.length, 3);
			for (const r of rows.values()) {
				for (const sport of r.sports?.split(',') ?? []) {
					assert.ok((r.day_strain ?? 0) >= strainOf[sport], `${r.date}: ${r.day_strain} < ${sport}`);
				}
			}
		});

		test('next-day recovery is the recovery of the following cycle', () => {
			const rows = byDay(db.getDailyTrainingLoad(DAYS));
			for (let i = 0; i < nights.length - 1; i++) {
				const today = nights[i];
				const next = nights[i + 1];
				assert.equal(rows.get(today.day)?.next_recovery, next.recovery, today.day);
				assert.equal(rows.get(today.day)?.next_hrv, next.hrv, today.day);
			}
			// Sun 18 is in progress: no next-day recovery yet
			assert.equal(rows.get('2026-10-18')?.next_recovery, null);
		});

		test("readiness 'yesterday' is the latest completed cycle, not today's open one", () => {
			assert.equal(db.getLatestCycle()?.strain, 0.2);
			const yesterday = db.getLatestCompletedCycle();
			assert.equal(yesterday?.strain, 3.2);
			assert.equal(yesterday?.id, 106);
		});
	});
}

test('timezone offsets and sleep.cycle_id are stored on upsert', () => {
	const db = load({ withOffsets: true, withSleepCycleId: true });
	const cycle = db.getLatestCycle();
	const sleep = db.getLatestSleep();
	assert.equal(cycle?.timezone_offset, '+02:00');
	assert.equal(sleep?.timezone_offset, '+02:00');
	assert.equal(sleep?.cycle_id, 107);
});

test('offset decides the label when waking just after local midnight', () => {
	// Asleep 00:00 local Sat, awake 01:30 local Sat (23:30 UTC Fri).
	// In UTC the sleep ends on Fri 16; in Copenhagen it ends on Sat 17.
	const db = new WhoopDatabase(':memory:');
	const f = buildFixture({ withOffsets: true, withSleepCycleId: true });
	const onset = '2026-10-16T22:00:00.000Z';
	const end = '2026-10-16T23:30:00.000Z';
	db.upsertCycles([{ ...f.cycles[6], start: onset }]);
	db.upsertSleeps([{ ...f.sleeps[6], start: onset, end }]);
	db.upsertRecoveries([{ ...f.recoveries[6], created_at: end }]);
	assert.deepEqual(db.getStrainTrends(DAYS).map(r => r.date), ['2026-10-17']);
	assert.deepEqual(db.getSleepTrends(DAYS).map(r => r.date), ['2026-10-17']);
});

test('migration adds timezone_offset to an existing database', async () => {
	const { default: Database } = await import('better-sqlite3');
	const { mkdtempSync, rmSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const dir = mkdtempSync(join(tmpdir(), 'whoop-test-'));
	const path = join(dir, 'old.db');
	try {
		// Recreate the pre-fix schema: same tables, without the new offset columns.
		new WhoopDatabase(path).close();
		const old = new Database(path);
		old.exec(`
			DROP VIEW cycle_days;
			ALTER TABLE cycles DROP COLUMN timezone_offset;
			ALTER TABLE sleep DROP COLUMN timezone_offset;
		`);
		old.close();
		const db = new WhoopDatabase(path);
		const f = buildFixture({ withOffsets: true, withSleepCycleId: true });
		db.upsertCycles(f.cycles);
		db.upsertSleeps(f.sleeps);
		assert.equal(db.getLatestCycle()?.timezone_offset, '+02:00');
		assert.equal(db.getLatestSleep()?.timezone_offset, '+02:00');
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
